import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Smartphone, Webhook, ClipboardList, Send, Key, KeyRound, Server, Puzzle, Bot, MessageSquareText } from 'lucide-react';
import { type UserRole } from '../hooks/useRole';
import './Settings.css';

interface SettingsProps {
  userRole: UserRole | null;
}

const settingsNavItems = [
  { to: 'sessions', icon: Smartphone, key: 'sessions' as const, adminOnly: false, advanced: false },
  { to: 'webhooks', icon: Webhook, key: 'webhooks' as const, adminOnly: false, advanced: true },
  { to: 'templates', icon: ClipboardList, key: 'templates' as const, adminOnly: false, advanced: true },
  { to: 'message-tester', icon: Send, key: 'messageTester' as const, adminOnly: false, advanced: true },
  { to: 'llm', icon: Bot, key: 'llm' as const, adminOnly: true, advanced: false },
  { to: 'keyproxy', icon: KeyRound, key: 'keyproxy' as const, adminOnly: true, advanced: false },
  { to: 'translate-prompt', icon: MessageSquareText, key: 'translatePrompt' as const, adminOnly: true, advanced: false },
  { to: 'api-keys', icon: Key, key: 'apiKeys' as const, adminOnly: true, advanced: true },
  { to: 'infrastructure', icon: Server, key: 'infrastructure' as const, adminOnly: true, advanced: false },
  { to: 'plugins', icon: Puzzle, key: 'plugins' as const, adminOnly: true, advanced: true },
];

const ADVANCED_KEY = 'settingsAdvanced';

export function Settings({ userRole }: SettingsProps) {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(() => localStorage.getItem(ADVANCED_KEY) === '1');
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const toggleAdvanced = () => {
    const next = !showAdvanced;
    setShowAdvanced(next);
    localStorage.setItem(ADVANCED_KEY, next ? '1' : '0');
    // Hiding the page you are standing on would leave the section stuck with no matching nav entry.
    if (!next && settingsNavItems.some(i => i.advanced && pathname.endsWith(`/${i.to}`))) {
      navigate('sessions', { replace: true });
    }
  };

  const items = settingsNavItems.filter(
    item => (!item.adminOnly || userRole === 'admin') && (showAdvanced || !item.advanced)
  );

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <span className="settings-nav-title">{t('nav.settings')}</span>
        {items.map(({ to, icon: Icon, key }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `settings-nav-item ${isActive ? 'active' : ''}`}>
            <Icon size={18} />
            <span>{t(`nav.${key}`)}</span>
          </NavLink>
        ))}
        <button type="button" className="settings-nav-advanced" onClick={toggleAdvanced}>
          {showAdvanced ? t('nav.hideAdvanced') : t('nav.showAdvanced')}
        </button>
      </nav>
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}

export default Settings;
