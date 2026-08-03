import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

/**
 * Per-group glossary overrides: the ONLY terms that need a scope.
 *
 * `Glossary.section()` matches on substring, so a term that is meaningful in one group but never
 * typed in another is already harmless globally — it simply never fires there. The single case that
 * genuinely needs scoping is a CONFLICT: the same source term where two groups want different
 * targets (出貨 → giao hàng in sales, xuất kho in production). Only those live here; everything else
 * stays in the shared glossary so the shared asset keeps growing.
 *
 * Both directions are stored, so a group's override also applies to its vi->zh traffic. Note that
 * shadowing only happens on the colliding SOURCE key: overriding 出貨→xuất kho adds
 * `vi:zh-tw[xuất kho]`, it does not shadow the global `vi:zh-tw[giao hàng]`. That is intended — the
 * global reverse mapping is still correct, it just isn't what this group produces.
 */

const FILE_VERSION = 2;
const KNOWN_SUFFIX = /@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/i;

/**
 * Stable key for a group JID. Strips only a known suffix and keeps the WHOLE local part.
 *
 * Deliberately NOT `jidDigits()`: that returns the first digit run, so the legacy group format
 * `<creatorDigits>-<createdTs>@g.us` collapses to the creator's digits — every legacy group made by
 * the same person would share one override layer, and it would collide with that person's personal
 * JID too. That is exactly the cross-group bleed this file exists to prevent.
 */
export function groupKey(jid: string): string {
  return jid.trim().replace(KNOWN_SUFFIX, '').toLowerCase();
}

type PairMap = Record<string, string>;
type GroupLayer = Record<string, PairMap>;

export interface OverrideEntry {
  group: string;
  pairKey: string;
  source: string;
  target: string;
}

export class OverrideLayer {
  private data: Record<string, GroupLayer> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the total override count (0 when absent — translate without them). */
  load(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      delete raw.__v; // version marker, not a group
      this.data = raw as Record<string, GroupLayer>;
      // A file written before empty-layer cleanup existed still carries the shells, and nothing
      // would ever clear them: cleanup only runs on a remove or a prune for that same group.
      // Write back when it found any, so the FILE heals too — cleaning only memory would leave the
      // shell on disk to be re-read and re-cleaned on every boot. Same shape as migrateReversed().
      if (this.dropEmptyLayers()) this.save();
      return this.count();
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    atomicWriteJson(this.filePath, { __v: FILE_VERSION, ...this.data });
  }

  count(): number {
    let n = 0;
    for (const layer of Object.values(this.data)) {
      // zh-tw:vi only — the vi:zh-tw mirror is the same override counted twice.
      n += Object.keys(layer['zh-tw:vi'] || {}).length;
    }
    return n;
  }

  /** Override count per group key, for the "is this worth full layering yet" decision. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [group, layer] of Object.entries(this.data)) {
      out[group] = Object.keys(layer['zh-tw:vi'] || {}).length;
    }
    return out;
  }

  /** The override target for one source in one group, or undefined. */
  get(groupId: string, pairKey: string, source: string): string | undefined {
    return this.data[groupKey(groupId)]?.[pairKey]?.[source];
  }

  /** All overrides for one group + direction, as [source, target] pairs. */
  entriesFor(groupId: string, pairKey: string): [string, string][] {
    return Object.entries(this.data[groupKey(groupId)]?.[pairKey] || {});
  }

  /**
   * Flat list for the dashboard/API — Wave A ships this before any write path is exposed.
   * Canonical direction only, matching count(): the vi->zh mirror is the same override and listing
   * it would double every row.
   */
  all(): OverrideEntry[] {
    const out: OverrideEntry[] = [];
    for (const [group, layer] of Object.entries(this.data)) {
      for (const [source, target] of Object.entries(layer['zh-tw:vi'] || {})) {
        out.push({ group, pairKey: 'zh-tw:vi', source, target });
      }
    }
    return out;
  }

  /** Write an override in both directions. `zh`/`vi` are expected already oriented by the caller. */
  set(groupId: string, zh: string, vi: string): void {
    const key = groupKey(groupId);
    const layer = (this.data[key] ??= {});
    (layer['zh-tw:vi'] ??= {})[zh] = vi;
    (layer['vi:zh-tw'] ??= {})[vi] = zh;
    this.save();
  }

  /**
   * Remove an override from ONE group, matching either side. Returns whether anything went.
   * Never falls through to the global layer — a member deleting in their group must not be able to
   * reach the shared glossary, so "not found here" is the answer, not "look upward".
   */
  remove(groupId: string, term: string): boolean {
    const layer = this.data[groupKey(groupId)];
    if (!layer) return false;
    let removed = false;
    for (const terms of Object.values(layer)) {
      for (const [s, t] of Object.entries(terms)) {
        if (s === term || t === term) {
          delete terms[s];
          removed = true;
        }
      }
    }
    if (removed) {
      this.dropEmptyLayers();
      this.save();
    }
    return removed;
  }

  /**
   * Drop overrides that now say exactly what the shared glossary says, and report how many went.
   *
   * An override only means something as a deviation. The moment an admin adopts a group's wording
   * into the shared glossary, that group's override stops overriding anything — it becomes a row
   * that reads "生產 → sản xuất, shared: sản xuất" and never goes away on its own. Left alone these
   * accumulate one per adopted suggestion, which is exactly the "duplication has to be self-healing
   * or it won't heal" failure the design set out to avoid.
   *
   * Takes the whole batch and saves once, matching Glossary.addMany's one-write-per-file rule.
   */
  pruneRedundant(pairs: { zh: string; vi: string }[]): number {
    let pruned = 0;
    for (const layer of Object.values(this.data)) {
      for (const { zh, vi } of pairs) {
        if (layer['zh-tw:vi']?.[zh] !== vi) continue;
        delete layer['zh-tw:vi'][zh];
        // The reverse entry is the same override seen from the other side; leaving it behind would
        // keep shadowing vi->zh for that group after the forward half is gone.
        if (layer['vi:zh-tw']?.[vi] === zh) delete layer['vi:zh-tw'][vi];
        pruned++;
      }
    }
    if (pruned) {
      this.dropEmptyLayers();
      this.save();
    }
    return pruned;
  }

  /**
   * Forget a group once its last override is gone. Otherwise the empty shell lingers, counts()
   * reports the group with 0, and it shows up as a group that has overrides when it has none.
   */
  private dropEmptyLayers(): boolean {
    let dropped = false;
    for (const [group, layer] of Object.entries(this.data)) {
      if (!Object.keys(layer['zh-tw:vi'] || {}).length && !Object.keys(layer['vi:zh-tw'] || {}).length) {
        delete this.data[group];
        dropped = true;
      }
    }
    return dropped;
  }

  /** Groups that override `source` to exactly `target` — drives the "≥2 groups agree" merge prompt. */
  groupsAgreeingOn(source: string, target: string): string[] {
    return Object.entries(this.data)
      .filter(([, layer]) => layer['zh-tw:vi']?.[source] === target)
      .map(([group]) => group);
  }

  /** Override group keys that are no longer configured — orphans left by a removed group. */
  orphans(configuredGroupIds: Iterable<string>): string[] {
    const live = new Set([...configuredGroupIds].map(groupKey));
    return Object.keys(this.data).filter(g => !live.has(g));
  }
}
