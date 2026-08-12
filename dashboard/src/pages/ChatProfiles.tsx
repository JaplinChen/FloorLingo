import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ScrollText, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { translateApi, type ChatProfileEntry } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { ConfirmModal } from '../components/sessions/ConfirmModal';
import '../components/EditableTable.css';
import './ChatProfiles.css';

const TEXT_MAX = 500;

export function ChatProfiles() {
  const { t } = useTranslation();
  useDocumentTitle(t('profiles.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  // Declared before the loader effect that calls it — see the same note in Glossary.tsx.
  const fail = (err: unknown) =>
    toast.error(t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }));

  const [entries, setEntries] = useState<ChatProfileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [chatIdInput, setChatIdInput] = useState('');
  const [textInput, setTextInput] = useState('');
  // POST upserts on the chatId, so editing only touches the text; the key stays read-only.
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    translateApi
      .getChatProfiles()
      .then(list => active && setEntries(list))
      .catch(err => active && fail(err))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const upsert = async (chatId: string, text: string, successMsg: string) => {
    setBusy(true);
    try {
      setEntries(await translateApi.addChatProfile(chatId, text));
      toast.success(successMsg);
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const chatId = chatIdInput.trim();
    const text = textInput.trim();
    if (!chatId || !text) return;
    if (await upsert(chatId, text, t('profiles.added'))) {
      setChatIdInput('');
      setTextInput('');
    }
  };

  const saveEdit = async (chatId: string) => {
    const text = editText.trim();
    if (!text) return;
    if (await upsert(chatId, text, t('common.saved'))) setEditing(null);
  };

  const remove = async (chatId: string) => {
    setBusy(true);
    try {
      setEntries(await translateApi.removeChatProfile(chatId));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="chat-profiles-page etable-page etable-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="chat-profiles-page etable-page">
      <PageHeader title={t('profiles.title')} subtitle={t('profiles.subtitle')} />

      <section className="etable-panel">
        <div className="etable-head">
          <h3 className="etable-panel-title">
            {t('profiles.entries')}
            <span className="etable-count">{entries.length}</span>
          </h3>
        </div>

        {canWrite && (
          <div className="etable-add profiles-add">
            <input
              type="text"
              placeholder={t('profiles.chatId')}
              aria-label={t('profiles.chatId')}
              value={chatIdInput}
              onChange={e => setChatIdInput(e.target.value)}
            />
            <textarea
              rows={3}
              maxLength={TEXT_MAX}
              placeholder={t('profiles.text')}
              aria-label={t('profiles.text')}
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
            />
            <div className="profiles-add-foot">
              <span className="profiles-chars">
                {t('profiles.chars', { n: textInput.length, max: TEXT_MAX })}
              </span>
              <button
                className="btn-primary"
                onClick={add}
                disabled={busy || !chatIdInput.trim() || !textInput.trim()}
              >
                <Plus size={16} />
                {t('profiles.add')}
              </button>
            </div>
          </div>
        )}

        <div className="etable-list">
          {entries.length > 0 && (
            <div className="etable-cols profiles-cols">
              <span className="etable-col-label">{t('profiles.chatId')}</span>
              <span className="etable-col-label">{t('profiles.text')}</span>
              {canWrite && <span className="etable-col-label">{t('common.actions')}</span>}
            </div>
          )}
          {entries.length === 0 ? (
            <div className="etable-empty">
              <ScrollText size={32} strokeWidth={1} />
              <p>{t('profiles.empty')}</p>
            </div>
          ) : (
            entries.map(entry =>
              editing === entry.chatId ? (
                <div key={entry.chatId} className="etable-item profiles-item etable-item--editing">
                  <span className="etable-src">{entry.chatId}</span>
                  <textarea
                    rows={3}
                    maxLength={TEXT_MAX}
                    aria-label={t('profiles.text')}
                    autoFocus
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => e.key === 'Escape' && setEditing(null)}
                  />
                  <div className="etable-row-actions">
                    <button
                      className="etable-del"
                      onClick={() => void saveEdit(entry.chatId)}
                      disabled={busy || !editText.trim()}
                      title={t('common.save')}
                    >
                      <Check size={16} />
                    </button>
                    <button
                      className="etable-del"
                      onClick={() => setEditing(null)}
                      disabled={busy}
                      title={t('common.cancel')}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div key={entry.chatId} className="etable-item profiles-item">
                  <span className="etable-src">{entry.chatId}</span>
                  <span className="etable-tgt profiles-text">{entry.text}</span>
                  {canWrite && (
                    <div className="etable-row-actions">
                      <button
                        className="etable-del"
                        onClick={() => {
                          setEditing(entry.chatId);
                          setEditText(entry.text);
                        }}
                        disabled={busy}
                        title={t('common.edit')}
                      >
                        <Pencil size={16} strokeWidth={1.5} />
                      </button>
                      <button
                        className="etable-del"
                        onClick={() => setPendingDelete(entry.chatId)}
                        disabled={busy}
                        title={t('common.delete')}
                      >
                        <Trash2 size={16} strokeWidth={1.5} />
                      </button>
                    </div>
                  )}
                </div>
              ),
            )
          )}
        </div>

        {pendingDelete !== null && (
          <ConfirmModal
            title={t('common.deleteConfirmTitle')}
            message={t('common.deleteConfirmBody', { name: pendingDelete })}
            warning={t('common.deleteConfirmWarning')}
            confirmLabel={t('common.delete')}
            onConfirm={() => {
              void remove(pendingDelete);
              setPendingDelete(null);
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </section>
    </div>
  );
}

export default ChatProfiles;
