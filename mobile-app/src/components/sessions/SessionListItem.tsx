import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/context/ThemeContext';
import type { SessionMeta } from '@/types/chat';

interface Props {
  session: SessionMeta;
  isActive: boolean;
  onPress: () => void;
  onDelete: () => void;
}

export default function SessionListItem({ session, isActive, onPress, onDelete }: Props) {
  const { colors } = useTheme();

  return (
    <TouchableOpacity
      style={[
        styles.container,
        { borderBottomColor: colors.border },
        isActive && { backgroundColor: colors.bgSecondary }
      ]}
      onPress={onPress}
    >
      <View style={styles.content}>
        <Ionicons
          name={isActive ? "chatbubble-ellipses" : "chatbubble-outline"}
          size={18}
          color={isActive ? colors.primary : colors.textMuted}
        />
        <Text
          style={[
            styles.title,
            { color: isActive ? colors.text : colors.textSecondary },
            isActive && styles.activeTitle
          ]}
          numberOfLines={1}
        >
          {session.title || 'Untitled Conversation'}
        </Text>
      </View>
      <TouchableOpacity onPress={onDelete} style={styles.deleteBtn}>
        <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  title: {
    fontSize: 14,
    flex: 1,
  },
  activeTitle: {
    fontWeight: '600',
  },
  deleteBtn: {
    padding: 4,
    marginLeft: 8,
  },
});
