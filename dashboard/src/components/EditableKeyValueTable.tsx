import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Search, Plus, Trash2, Pencil, SearchX } from 'lucide-react';
import { useResizableCol } from '../hooks/useResizableCol';
import { useSortableTable, PAGE_SIZE } from '../hooks/useSortableTable';
import { pageWindow } from '../utils/pageWindow';
import { ConfirmModal } from './sessions/ConfirmModal';
import './EditableTable.css';

export type TableSortKey = 'key' | 'val' | 'count';

interface Props<T> {
  rows: T[];
  titleLabel: string;
  keyLabel: string;
  valLabel: string;
  addLabel: string;
  emptyIcon: ReactNode;
  emptyText: string;
  canWrite: boolean;
  busy: boolean;
  resizeStorageKey: string;
  initialSortKey: TableSortKey;
  rowKey: (row: T) => string;
  rowVal: (row: T) => string;
  rowCount: (row: T) => number;
  renderKey?: (row: T) => ReactNode;
  compareKey: (a: T, b: T) => number;
  compareVal: (a: T, b: T) => number;
  tieBreak: (a: T, b: T) => number;
  onAdd: (key: string, val: string, category?: string) => Promise<boolean>;
  onSaveEdit: (originalKey: string, key: string, val: string, category?: string) => Promise<boolean>;
  onRemove: (key: string) => void;
  // Optional category column: pass these to render a per-row category select (glossary uses it;
  // other tables like senders omit them and the column is hidden entirely).
  categoryLabel?: string;
  categoryOptions?: { value: string; label: string }[];
  rowCategory?: (row: T) => string;
  // The glossary tab bar already shows the title + count, so the panel header would just repeat it.
  hideTitle?: boolean;
}

// Right-edge drag handle for a resizable column; stops click/mousedown from reaching the sort button.
// Module level, not nested in the table component: a component created during render is a NEW type on
// every render, so React unmounts and remounts the subtree instead of updating it (react-hooks/static-components).
function ResizeHandle({ col, onStart }: { col: string; onStart: (col: string) => (e: React.MouseEvent) => void }) {
  return (
    <span
      className="etable-resize-handle"
      aria-hidden="true"
      onMouseDown={onStart(col)}
      onClick={e => e.stopPropagation()}
    />
  );
}

export function EditableKeyValueTable<T>({
  rows,
  titleLabel,
  keyLabel,
  valLabel,
  addLabel,
  emptyIcon,
  emptyText,
  canWrite,
  busy,
  resizeStorageKey,
  initialSortKey,
  rowKey,
  rowVal,
  rowCount,
  renderKey = rowKey,
  compareKey,
  compareVal,
  tieBreak,
  onAdd,
  onSaveEdit,
  onRemove,
  categoryLabel,
  categoryOptions,
  rowCategory,
  hideTitle,
}: Props<T>) {
  const { t } = useTranslation();
  const { ref: panelRef, startResize } = useResizableCol(resizeStorageKey);
  const hasCat = !!categoryOptions && !!rowCategory;
  const catLabelOf = (v: string) => categoryOptions?.find(o => o.value === v)?.label ?? v;

  // Category filter sits before search/sort: narrow the row set, then the hook searches+sorts+pages it.
  // '__all__' is the no-filter sentinel so an empty-string option can still mean the "未設" bucket.
  const [catFilter, setCatFilter] = useState('__all__');
  const catRows =
    hasCat && catFilter !== '__all__' ? rows.filter(r => rowCategory!(r) === catFilter) : rows;

  const { filter, setFilter, filtered, toggleSort, sortMark, current, totalPages, paged, setPage } =
    useSortableTable<T, TableSortKey>({
      rows: catRows,
      initialKey: initialSortKey,
      descFirstKeys: ['count'],
      // The category label is a visible column, so it has to be searchable — typing "部門" with it
      // excluded matched nothing while the word sat on screen.
      searchText: r => `${rowKey(r)}\n${rowVal(r)}${hasCat ? `\n${catLabelOf(rowCategory!(r))}` : ''}`,
      compare: (a, b, k) =>
        k === 'count' ? rowCount(a) - rowCount(b) : k === 'key' ? compareKey(a, b) : compareVal(a, b),
      tieBreak,
    });

  const [keyInput, setKeyInput] = useState('');
  const [valInput, setValInput] = useState('');
  const [catInput, setCatInput] = useState('');
  // The key column is the record's key, so the row being edited is tracked by its original key;
  // renaming one has to drop the old key, which `editing` still holds.
  const [editing, setEditing] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [editVal, setEditVal] = useState('');
  const [editCat, setEditCat] = useState('');
  // Delete used to fire straight from the row button, one 24px target away from Edit.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Rows exist but a filter hid them all — distinct from "this table has no rows".
  const narrowed = rows.length > 0 && (!!filter.trim() || catFilter !== '__all__');
  const resetFilters = () => {
    setFilter('');
    setCatFilter('__all__');
  };

  const add = async () => {
    const k = keyInput.trim();
    const v = valInput.trim();
    if (!k || !v) return;
    if (await onAdd(k, v, hasCat ? catInput : undefined)) {
      setKeyInput('');
      setValInput('');
      setCatInput('');
    }
  };

  const startEdit = (row: T) => {
    setEditing(rowKey(row));
    setEditKey(rowKey(row));
    setEditVal(rowVal(row));
    setEditCat(hasCat ? rowCategory!(row) : '');
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = async (row: T) => {
    const k = editKey.trim();
    const v = editVal.trim();
    if (!k || !v) return;
    const catChanged = hasCat && editCat !== rowCategory!(row);
    if (k === rowKey(row) && v === rowVal(row) && !catChanged) {
      setEditing(null);
      return;
    }
    if (await onSaveEdit(rowKey(row), k, v, hasCat ? editCat : undefined)) setEditing(null);
  };

  return (
    <section className="etable-panel" ref={panelRef as React.RefObject<HTMLElement>}>
      {!hideTitle && (
        <div className="etable-head">
          <h3 className="etable-panel-title">
            {titleLabel}
            <span className="etable-count">{rows.length}</span>
          </h3>
        </div>
      )}

      {canWrite && (
        <div className="etable-add">
          <input
            type="text"
            placeholder={keyLabel}
            aria-label={keyLabel}
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
          />
          <span className="etable-arrow">→</span>
          <input
            type="text"
            placeholder={valLabel}
            aria-label={valLabel}
            value={valInput}
            onChange={e => setValInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
          />
          {hasCat && (
            <select
              className="etable-cat-select etable-cat-add"
              aria-label={categoryLabel}
              value={catInput}
              onChange={e => setCatInput(e.target.value)}
            >
              {/* Same labels as the filter select: this one used to relabel the ''-value option as
                  "類別" while the filter called it "未設", so one page named the bucket twice. */}
              {categoryOptions!.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn-primary" onClick={add} disabled={busy || !keyInput.trim() || !valInput.trim()}>
            <Plus size={16} />
            {addLabel}
          </button>
        </div>
      )}

      <div className="etable-search">
        <div className="etable-search-field">
          <Search size={16} className="etable-search-icon" />
          <input
            type="text"
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setFilter('')}
          />
          {filter && (
            <button className="etable-search-clear" onClick={() => setFilter('')} title={t('common.clearSearch')}>
              <X size={14} />
            </button>
          )}
        </div>
        {hasCat && (
          // Labelled, because the bare select sat beside the search box wearing the same border and
          // background — there was no way to tell which of the two you could type into.
          <label className="etable-cat-filter-label">
            {categoryLabel}
            <select
              className="etable-cat-select etable-cat-filter"
              value={catFilter}
              onChange={e => setCatFilter(e.target.value)}
            >
              <option value="__all__">{t('common.all')}</option>
              {categoryOptions!.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {filtered.length > 0 && (
        <div className={`etable-cols${hasCat ? ' etable-cols--cat' : ''}`}>
          <button className="etable-col-sort" data-col="key" onClick={() => toggleSort('key')}>
            {keyLabel}{sortMark('key')}
            <ResizeHandle col="key" onStart={startResize} />
          </button>
          <span className="etable-col-resize" aria-hidden="true">→</span>
          <button className="etable-col-sort" data-col="val" onClick={() => toggleSort('val')}>
            {valLabel}{sortMark('val')}
            <ResizeHandle col="val" onStart={startResize} />
          </button>
          <button className="etable-col-sort etable-col-sort--num" data-col="count" onClick={() => toggleSort('count')}>
            {t('common.usageCount')}{sortMark('count')}
            <ResizeHandle col="count" onStart={startResize} />
          </button>
          {hasCat && (
            <span className="etable-col-label" data-col="cat">
              {categoryLabel}
              <ResizeHandle col="cat" onStart={startResize} />
            </span>
          )}
          {canWrite && <span className="etable-col-label">{t('common.actions')}</span>}
        </div>
      )}
      <div className="etable-list">
        {filtered.length === 0 ? (
          // A search that matches nothing is not an empty glossary. Showing the "no terms yet"
          // state there reads as data loss and offers no way back.
          narrowed ? (
            <div className="etable-empty">
              <SearchX size={32} strokeWidth={1} />
              <p>{t('common.noResults', { query: filter || catLabelOf(catFilter) })}</p>
              <button className="btn-secondary" onClick={resetFilters}>
                {t('common.clearSearchAction')}
              </button>
            </div>
          ) : (
            <div className="etable-empty">
              {emptyIcon}
              <p>{emptyText}</p>
            </div>
          )
        ) : (
          paged.map(row =>
            editing === rowKey(row) ? (
              <div key={rowKey(row)} className={`etable-item etable-item--editing${hasCat ? ' etable-item--cat' : ''}`}>
                <input
                  className="etable-edit"
                  value={editKey}
                  aria-label={keyLabel}
                  autoFocus
                  onChange={e => setEditKey(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveEdit(row);
                    if (e.key === 'Escape') cancelEdit();
                  }}
                />
                <span className="etable-arrow">→</span>
                <input
                  className="etable-edit"
                  value={editVal}
                  aria-label={valLabel}
                  onChange={e => setEditVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveEdit(row);
                    if (e.key === 'Escape') cancelEdit();
                  }}
                />
                {hasCat && <span className="etable-usage" aria-hidden="true" />}
                {hasCat && (
                  <select
                    className="etable-cat-select"
                    aria-label={categoryLabel}
                    value={editCat}
                    onChange={e => setEditCat(e.target.value)}
                  >
                    {categoryOptions!.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                <div className="etable-row-actions">
                  <button
                    className="etable-del"
                    onClick={() => void saveEdit(row)}
                    disabled={busy || !editKey.trim() || !editVal.trim()}
                    title={t('common.save')}
                  >
                    <Check size={16} />
                  </button>
                  <button className="etable-del" onClick={cancelEdit} disabled={busy} title={t('common.cancel')}>
                    <X size={16} />
                  </button>
                </div>
              </div>
            ) : (
              <div key={rowKey(row)} className={`etable-item${hasCat ? ' etable-item--cat' : ''}`}>
                <span className="etable-src">{renderKey(row)}</span>
                <span className="etable-arrow">→</span>
                <span className="etable-tgt">{rowVal(row)}</span>
                <span className="etable-usage" title={t('common.usageCount')}>{rowCount(row)}</span>
                {hasCat && (
                  <span className="etable-cat" title={catLabelOf(rowCategory!(row))}>
                    {catLabelOf(rowCategory!(row))}
                  </span>
                )}
                {canWrite && (
                  <div className="etable-row-actions">
                    <button
                      className="etable-del"
                      onClick={() => startEdit(row)}
                      disabled={busy}
                      title={t('common.edit')}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="etable-del"
                      onClick={() => setPendingDelete(rowKey(row))}
                      disabled={busy}
                      title={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
            ),
          )
        )}
      </div>

      {filtered.length > 0 && (
        <p className="etable-range">
          {t('common.showingRange', {
            from: (current - 1) * PAGE_SIZE + 1,
            to: Math.min(current * PAGE_SIZE, filtered.length),
            total: filtered.length,
          })}
        </p>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={current === 1} onClick={() => setPage(current - 1)}>
            {t('common.previous')}
          </button>
          <span className="page-numbers">
            {pageWindow(current, totalPages).map(p => (
              <button key={p} className={p === current ? 'active' : ''} onClick={() => setPage(p)}>
                {p}
              </button>
            ))}
          </span>
          <button disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}

      {pendingDelete !== null && (
        <ConfirmModal
          title={t('common.deleteConfirmTitle')}
          message={t('common.deleteConfirmBody', { name: pendingDelete })}
          warning={t('common.deleteConfirmWarning')}
          confirmLabel={t('common.delete')}
          onConfirm={() => {
            onRemove(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
