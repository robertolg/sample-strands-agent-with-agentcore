#!/usr/bin/env python3 -u
"""
Agent Loop Caching Test Script

Tests the single cache point strategy for agent loop optimization.
Validates key insights from the blog post:
1. Single CP at end is optimal (avoids duplicate write premiums)
2. Multiple CPs don't improve cache hit rate
3. Separate system prompt caching is redundant

Usage:
    python test_caching.py                        # Run single turn test
    python test_caching.py --mode multi           # Multi-turn test
    python test_caching.py --mode compare-cp      # Compare 1 CP vs 3 CP
    python test_caching.py --mode compare-system  # Compare with/without system cache
"""

import argparse
import sys
import os

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import time
import asyncio
import logging
import warnings
from typing import List, Dict, Any

warnings.filterwarnings("ignore", message=".*cannot join thread.*")

logging.basicConfig(level=logging.WARNING, format='%(asctime)s - %(levelname)s - %(message)s')
logging.getLogger('strands').setLevel(logging.WARNING)
logging.getLogger('botocore').setLevel(logging.WARNING)
logging.getLogger('urllib3').setLevel(logging.WARNING)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'chatbot-app', 'agentcore', 'src'))

# Colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"


class SingleCPHook:
    """Optimal strategy: Single cache point at the end (after most recent tool result)"""

    def add_cache_points(self, messages: List[Dict]) -> None:
        # Find existing cache points and most recent tool result
        cache_positions = []
        last_tool_result = None

        for msg_idx, msg in enumerate(messages):
            content = msg.get("content", [])
            if not isinstance(content, list):
                continue
            for block_idx, block in enumerate(content):
                if isinstance(block, dict):
                    if "cachePoint" in block:
                        cache_positions.append((msg_idx, block_idx))
                    elif "toolResult" in block:
                        last_tool_result = (msg_idx, block_idx)

        if not last_tool_result:
            return

        tr_msg_idx, tr_block_idx = last_tool_result
        tr_content = messages[tr_msg_idx].get("content", [])

        # Check if CP already exists after this tool result
        next_idx = tr_block_idx + 1
        if next_idx < len(tr_content):
            if isinstance(tr_content[next_idx], dict) and "cachePoint" in tr_content[next_idx]:
                return

        # Remove all existing CPs
        for msg_idx, block_idx in reversed(cache_positions):
            content = messages[msg_idx].get("content", [])
            if isinstance(content, list) and block_idx < len(content):
                del content[block_idx]
                if msg_idx == tr_msg_idx and block_idx < tr_block_idx:
                    tr_block_idx -= 1

        # Add single CP at end
        tr_content = messages[tr_msg_idx].get("content", [])
        tr_content.insert(tr_block_idx + 1, {"cachePoint": {"type": "default"}})


class MultiCPHook:
    """Comparison strategy: Multiple cache points (sliding window)"""

    def __init__(self, max_cache_points: int = 3):
        self.max_cache_points = max_cache_points

    def add_cache_points(self, messages: List[Dict]) -> None:
        cache_positions = []
        tool_result_positions = []

        for msg_idx, msg in enumerate(messages):
            content = msg.get("content", [])
            if not isinstance(content, list):
                continue
            for block_idx, block in enumerate(content):
                if isinstance(block, dict):
                    if "cachePoint" in block:
                        cache_positions.append((msg_idx, block_idx))
                    elif "toolResult" in block:
                        tool_result_positions.append((msg_idx, block_idx))

        if not tool_result_positions:
            return

        last_tr_msg_idx, last_tr_block_idx = tool_result_positions[-1]
        last_tr_content = messages[last_tr_msg_idx].get("content", [])

        next_idx = last_tr_block_idx + 1
        if next_idx < len(last_tr_content):
            if isinstance(last_tr_content[next_idx], dict) and "cachePoint" in last_tr_content[next_idx]:
                return

        if len(cache_positions) >= self.max_cache_points:
            oldest_msg_idx, oldest_block_idx = cache_positions[0]
            content = messages[oldest_msg_idx].get("content", [])
            if isinstance(content, list) and oldest_block_idx < len(content):
                del content[oldest_block_idx]
                if oldest_msg_idx == last_tr_msg_idx and oldest_block_idx < last_tr_block_idx:
                    last_tr_block_idx -= 1

        last_tr_content = messages[last_tr_msg_idx].get("content", [])
        last_tr_content.insert(last_tr_block_idx + 1, {"cachePoint": {"type": "default"}})


async def run_test(strategy_name: str, cache_hook, use_system_cache: bool = False, num_turns: int = 1) -> Dict:
    """Run caching test with specified strategy"""
    from strands import Agent, tool
    from strands.models import BedrockModel
    from strands.hooks import HookProvider, HookRegistry, BeforeModelCallEvent

    print(f"\n{CYAN}{'='*60}{RESET}")
    print(f"{BOLD}Test: {strategy_name}{RESET}")
    if use_system_cache:
        print(f"  System cache: {GREEN}enabled{RESET}")
    else:
        print(f"  System cache: {YELLOW}disabled{RESET}")
    print(f"{CYAN}{'='*60}{RESET}")

    class TestHookProvider(HookProvider):
        def __init__(self, hook):
            self.hook = hook

        def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
            registry.add_callback(BeforeModelCallEvent, self.on_before_model)

        def on_before_model(self, event: BeforeModelCallEvent) -> None:
            if event.agent.messages:
                self.hook.add_cache_points(event.agent.messages)

    # System prompt (needs to be long enough for caching)
    system_prompt = """You are a research analyst. When asked to research a topic:
1. Use search_web to gather information
2. Use analyze_data to process findings
3. Use calculate_metrics for statistics
4. Use generate_report for final output

Always follow this sequence for comprehensive analysis.

Additional context: This system prompt needs sufficient length to meet the minimum token threshold for caching. The API requires at least 1024 tokens before a cache point can be effective.

Research methodology:
- Gather data from multiple sources
- Cross-reference findings for accuracy
- Apply statistical analysis where appropriate
- Present findings in clear, actionable format
- Include confidence levels for projections
- Note limitations or caveats in the analysis

Quality standards:
- All research must be verifiable
- Analysis should be objective and unbiased
- Reports should be concise yet comprehensive
- Recommendations should be actionable"""

    model_config = {
        "model_id": "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "temperature": 0.7
    }
    if use_system_cache:
        model_config["cache_prompt"] = "default"

    model = BedrockModel(**model_config)

    @tool
    def search_web(query: str) -> str:
        """Search the web for information"""
        time.sleep(0.2)
        return f"Search results for '{query}': Found relevant data and insights."

    @tool
    def analyze_data(data: str) -> str:
        """Analyze the provided data"""
        time.sleep(0.2)
        return f"Analysis of '{data}': Positive trends with 15% growth."

    @tool
    def calculate_metrics(values: str) -> str:
        """Calculate metrics from values"""
        time.sleep(0.2)
        return f"Metrics: Mean=75, Median=72, StdDev=12.5"

    @tool
    def generate_report(topic: str) -> str:
        """Generate a report on the topic"""
        time.sleep(0.2)
        return f"Report on '{topic}': Executive summary with recommendations."

    tools = [search_web, analyze_data, calculate_metrics, generate_report]

    agent = Agent(
        model=model,
        system_prompt=system_prompt,
        tools=tools,
        hooks=[TestHookProvider(cache_hook)]
    )

    prompts = [
        "Research AI trends in healthcare. Use search_web and analyze_data.",
        "Now research AI in finance and compare. Use all tools.",
        "Generate a final comparison report."
    ]

    all_metrics = []
    total_input = 0
    total_cache_read = 0
    total_cache_write = 0
    total_calls = 0

    for turn_idx in range(min(num_turns, len(prompts))):
        prompt = prompts[turn_idx]
        print(f"\n{YELLOW}--- Turn {turn_idx + 1} ---{RESET}")

        llm_metrics = []
        call_num = [0]

        async for event in agent.stream_async(prompt):
            if isinstance(event, dict):
                if "event" in event and isinstance(event["event"], dict):
                    raw = event["event"]
                    if "metadata" in raw:
                        usage = raw["metadata"].get("usage", {})
                        if usage.get("inputTokens", 0) > 0:
                            call_num[0] += 1
                            m = {
                                'call': call_num[0],
                                'input': usage.get('inputTokens', 0),
                                'cache_read': usage.get('cacheReadInputTokens', 0),
                                'cache_write': usage.get('cacheWriteInputTokens', 0),
                            }
                            llm_metrics.append(m)

                            total = m['cache_read'] + m['cache_write'] + m['input']
                            rate = (m['cache_read'] / total * 100) if total > 0 else 0
                            print(f"  {BLUE}Call {call_num[0]}:{RESET} in={m['input']:,}, read={m['cache_read']:,}, write={m['cache_write']:,}, hit={rate:.1f}%")

                if "current_tool_use" in event:
                    tool_name = event["current_tool_use"].get("name")
                    if tool_name:
                        print(f"  Tool: {tool_name}")

        if llm_metrics:
            turn_input = sum(m['input'] for m in llm_metrics)
            turn_read = sum(m['cache_read'] for m in llm_metrics)
            turn_write = sum(m['cache_write'] for m in llm_metrics)
            total_input += turn_input
            total_cache_read += turn_read
            total_cache_write += turn_write
            total_calls += len(llm_metrics)

            turn_total = turn_input + turn_read + turn_write
            turn_rate = (turn_read / turn_total * 100) if turn_total > 0 else 0
            print(f"\n  {GREEN}Turn Summary:{RESET} input={turn_input:,}, read={turn_read:,}, write={turn_write:,}, hit={turn_rate:.1f}%")
            all_metrics.append(llm_metrics)

    # Final summary
    overall_total = total_input + total_cache_read + total_cache_write
    hit_rate = (total_cache_read / overall_total * 100) if overall_total > 0 else 0

    # Cost calculation
    INPUT_PRICE = 3.00 / 1_000_000
    CACHE_WRITE_PRICE = 3.75 / 1_000_000
    CACHE_READ_PRICE = 0.30 / 1_000_000

    cost = total_input * INPUT_PRICE + total_cache_write * CACHE_WRITE_PRICE + total_cache_read * CACHE_READ_PRICE
    no_cache_cost = overall_total * INPUT_PRICE
    savings = no_cache_cost - cost
    savings_pct = (savings / no_cache_cost * 100) if no_cache_cost > 0 else 0

    print(f"\n{CYAN}{'='*60}{RESET}")
    print(f"{BOLD}Summary: {strategy_name}{RESET}")
    print(f"  Total Input:     {total_input:,}")
    print(f"  Cache Read:      {total_cache_read:,}")
    print(f"  Cache Write:     {total_cache_write:,}")
    print(f"  Hit Rate:        {hit_rate:.1f}%")
    print(f"  Cost:            ${cost:.4f}")
    print(f"  Without Cache:   ${no_cache_cost:.4f}")
    print(f"  Savings:         ${savings:.4f} ({savings_pct:.1f}%)")

    return {
        'strategy': strategy_name,
        'total_input': total_input,
        'cache_read': total_cache_read,
        'cache_write': total_cache_write,
        'hit_rate': hit_rate,
        'cost': cost,
        'savings_pct': savings_pct,
        'calls': total_calls
    }


def print_comparison(results: List[Dict], title: str):
    """Print comparison table"""
    print(f"\n{CYAN}{'='*70}{RESET}")
    print(f"{BOLD}{title}{RESET}")
    print(f"{CYAN}{'='*70}{RESET}")

    print(f"\n{'Metric':<20}", end="")
    for r in results:
        print(f"{r['strategy'][:15]:>15}", end="")
    print()
    print("-" * (20 + 15 * len(results)))

    metrics = [
        ('Input Tokens', 'total_input', '{:,}'),
        ('Cache Read', 'cache_read', '{:,}'),
        ('Cache Write', 'cache_write', '{:,}'),
        ('Hit Rate', 'hit_rate', '{:.1f}%'),
        ('Cost', 'cost', '${:.4f}'),
        ('Savings', 'savings_pct', '{:.1f}%'),
    ]

    for label, key, fmt in metrics:
        print(f"{label:<20}", end="")
        for r in results:
            val = r[key]
            print(f"{fmt.format(val):>15}", end="")
        print()

    # Winner
    print(f"\n{CYAN}{'='*70}{RESET}")
    min_cost = min(r['cost'] for r in results)
    winners = [r['strategy'] for r in results if r['cost'] == min_cost]
    if len(winners) == 1:
        print(f"{GREEN}{BOLD}Most Cost-Effective: {winners[0]}{RESET}")
    else:
        print(f"{YELLOW}{BOLD}Tie: {', '.join(winners)}{RESET}")


async def main():
    parser = argparse.ArgumentParser(description='Test agent loop caching strategies')
    parser.add_argument('--mode', choices=['single', 'multi', 'compare-cp', 'compare-system'],
                        default='single', help='Test mode')
    parser.add_argument('--turns', type=int, default=2, help='Number of turns')
    args = parser.parse_args()

    print(f"\n{BOLD}Agent Loop Caching Test{RESET}")
    print(f"Mode: {args.mode}")

    if args.mode == 'single':
        await run_test("Single CP Strategy", SingleCPHook(), num_turns=args.turns)

    elif args.mode == 'multi':
        await run_test("Single CP (Multi-turn)", SingleCPHook(), num_turns=3)

    elif args.mode == 'compare-cp':
        # Compare 1 CP vs 3 CP
        print(f"\n{YELLOW}Testing 1 CP strategy...{RESET}")
        r1 = await run_test("1 CP", SingleCPHook(), num_turns=args.turns)

        print(f"\n{YELLOW}Waiting 10 seconds...{RESET}")
        await asyncio.sleep(10)

        print(f"\n{YELLOW}Testing 3 CP strategy...{RESET}")
        r3 = await run_test("3 CP", MultiCPHook(max_cache_points=3), num_turns=args.turns)

        print_comparison([r1, r3], "Comparison: 1 CP vs 3 CP")

    elif args.mode == 'compare-system':
        # Compare with vs without system cache
        print(f"\n{YELLOW}Testing without system cache...{RESET}")
        r_without = await run_test("Without SysCache", SingleCPHook(), use_system_cache=False, num_turns=args.turns)

        print(f"\n{YELLOW}Waiting 10 seconds...{RESET}")
        await asyncio.sleep(10)

        print(f"\n{YELLOW}Testing with system cache...{RESET}")
        r_with = await run_test("With SysCache", SingleCPHook(), use_system_cache=True, num_turns=args.turns)

        print_comparison([r_without, r_with], "Comparison: System Cache Effect")


if __name__ == "__main__":
    asyncio.run(main())
