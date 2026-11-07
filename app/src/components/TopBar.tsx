import { useMatch } from 'react-router-dom';

import { useChat, useRecentChats } from '../lib/chatStore';
import { useTheme } from '../lib/useTheme';
import { HorizonMark } from './HorizonMark';
import { Icon } from './Icon';

interface TopBarProps {
  onOpenSidebar: () => void;
}

export function TopBar({ onOpenSidebar }: TopBarProps) {
  const { theme, toggle } = useTheme();
  const chat = useMatch('/chat/:chatId/*');
  const chatId = chat?.params.chatId;
  const loaded = useChat(chatId);
  const recents = useRecentChats();
  const title = chatId ? (loaded?.title ?? recents.find((r) => r.id === chatId)?.title ?? 'New chat') : '';

  return (
    <header className="top">
      <button className="icon menu" aria-label="Open sidebar" onClick={onOpenSidebar}>
        <Icon name="menu" />
      </button>
      <span className="mbrand">
        <HorizonMark size={22} label="Horizon" />
      </span>
      <div className="title">
        {title && (
          <>
            {title} <Icon name="down" small />
          </>
        )}
      </div>
      {chat && (
        <button className="ghost hidem">
          <Icon name="share" />
          Share
        </button>
      )}
      <button
        className="icon"
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggle}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <button className="icon" aria-label="Notifications, 1 unread">
        <Icon name="bell" />
        <span className="unread" />
      </button>
    </header>
  );
}
