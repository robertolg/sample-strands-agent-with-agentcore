import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Pressable, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import type { Message } from '../../types/chat'
import MessageBubble from './MessageBubble'
import ThinkingIndicator from './ThinkingIndicator'

interface Props {
  messages: Message[]
  isThinking: boolean
  thinkingLabel: string
  hasMore?: boolean
  onLoadMore?: () => void
}

export default function MessageList({ messages, isThinking, thinkingLabel, hasMore, onLoadMore }: Props) {
  const { colors } = useTheme()
  const flatListRef = useRef<FlatList>(null)
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false)
  const loadMoreGuard = useRef(false)
  const hasUserScrolled = useRef(false)

  // Reverse messages for inverted list (latest at the bottom/index 0)
  const reversedMessages = React.useMemo(() => [...messages].reverse(), [messages])

  // In an inverted list, index 0 is the bottom.
  // We scroll to offset 0 to stay at the bottom.
  useEffect(() => {
    if (messages.length === 0 || isUserScrolledUp) return
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [messages.length, isThinking, isUserScrolledUp])

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      if (!hasUserScrolled.current) return

      // Inverted list: scroll up means contentOffset.y increases
      setIsUserScrolledUp(contentOffset.y > 100)

      // Near "top" (which is the end of the data in inverted list) — load more
      if (contentOffset.y > 300 && hasMore && onLoadMore && !loadMoreGuard.current) {
        loadMoreGuard.current = true
        onLoadMore()
        setTimeout(() => { loadMoreGuard.current = false }, 500)
      }
    },
    [hasMore, onLoadMore],
  )

  const handleScrollBeginDrag = useCallback(() => {
    hasUserScrolled.current = true
  }, [])

  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true })
    setIsUserScrolledUp(false)
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <View style={styles.bubbleWrapper}>
        <MessageBubble message={item} />
      </View>
    ),
    [],
  )

  const keyExtractor = useCallback((item: Message) => item.id, [])

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={flatListRef}
        data={reversedMessages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        scrollEventThrottle={16} // Increased for smoother scroll tracking
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
        }}
        ListHeaderComponent={
          isThinking ? (
            <View style={styles.thinkingRow}>
              <ThinkingIndicator label={thinkingLabel} />
            </View>
          ) : null
        }
        ListFooterComponent={
          hasMore ? (
            <View style={styles.loadMoreRow}>
              <ActivityIndicator size="small" color={colors.textMuted} />
            </View>
          ) : null
        }
      />

      {isUserScrolledUp && (
        <Pressable
          style={[styles.scrollToBottomBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={scrollToBottom}
        >
          <Ionicons name="chevron-down" size={20} color={colors.text} />
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 8,
    paddingBottom: 16,
  },
  bubbleWrapper: {
    // No rotation needed because FlatList handles it, 
    // but ensures layout remains stable.
  },
  loadMoreRow: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  thinkingRow: {
    paddingVertical: 12,
    paddingBottom: 20,
  },
  scrollToBottomBtn: {
    position: 'absolute',
    bottom: 12,
    right: 16,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
})
