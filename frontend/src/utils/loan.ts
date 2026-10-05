/**
 * 外借展览对账业务逻辑（纯函数 + 本侧 / 外馆两侧隔离）
 *
 * 约定：
 * - 点交单是「外馆那份」：收下时解析落库一次，之后本侧写库失败重试只动本馆拓本与条目的本侧字段，
 *   绝不改写外馆原始字段（收藏号、展柜号、拓法记录等）。
 * - 对账顺序：先按收藏号；收藏号认不上再按展柜号；都认不上挂「待认领」。
 * - 对上只在本馆拓本挂借出标记（loanState / loanManifestId / loanCaseNo），拓法照旧，不改 method 等编目字段。
 * - 状况记录同一件以晚到（receivedAt 更大）为准；新损伤只在借展侧记录，不并入本馆 losses。
 */
import type { Rubbing } from '@/types/rubbing';
import type { LoanManifestItem, LoanMatchState } from '@/types/loan';
import type { LoanCondition } from '@/types/loanCondition';

/** 解析后的点交单原始行（外馆字段，尚未对账） */
export interface ParsedManifestLine {
  lineNo: number;
  collectionNo: string;
  caseNo: string;
  methodNote: string;
  remark: string;
}

/** 单行分隔：逗号 / 中文逗号 / Tab / 多空白 */
const CELL_SPLIT = /[，,\t]|\s+/;

function cleanCell(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * 解析点交单文本。
 * 每行一条，字段顺序：收藏号、展柜号、拓法记录、备注；
 * 首行若第一格不是数字行号且包含「收藏号」字样视为表头并跳过；
 * 允许显式行号（数字开头）也允许省略行号（按出现顺序补号）。
 */
export function parseManifestText(raw: string): { lines: ParsedManifestLine[]; errors: string[] } {
  const errors: string[] = [];
  const lines: ParsedManifestLine[] = [];
  const textLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  textLines.forEach((textLine, index) => {
    const cells = textLine.split(CELL_SPLIT).map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    if (cells.length === 0) return;

    // 跳过表头
    if (index === 0 && cells[0]?.includes('收藏号')) return;

    let lineNo: number;
    let rest: string[];
    const leading = Number.parseInt(cells[0] ?? '', 10);
    if (Number.isFinite(leading) && (cells[0] ?? '').match(/^\d+$/)) {
      lineNo = leading;
      rest = cells.slice(1);
    } else {
      lineNo = index + 1;
      rest = cells;
    }

    const collectionNo = cleanCell(rest[0]);
    const caseNo = cleanCell(rest[1]);
    const methodNote = cleanCell(rest[2]);
    const remark = cleanCell(rest.slice(3).join(' '));

    if (!collectionNo && !caseNo) {
      errors.push(`第 ${lineNo} 行缺少收藏号与展柜号，无法对账`);
      return;
    }
    lines.push({ lineNo, collectionNo, caseNo, methodNote, remark });
  });

  return { lines, errors };
}

function normalizeNo(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

/**
 * 按「收藏号 → 展柜号」顺序对账，生成点交单条目（外馆字段 + 本侧对账结果）。
 * - 第一依据收藏号：本馆拓本收藏号唯一命中即对上（已被本单前一条占用的不再重复命中）。
 * - 收藏号认不上的，保留外馆展柜号并挂「待认领」，由编目员在对账台凭展柜号人工认上
 *   （展柜号是外馆侧标识，本馆拓本不登记展柜号，无法自动比对）。
 * - 多义命中（同收藏号多个拓本）也视为认不上，挂待认领先人工处理。
 */
export function reconcileManifest(lines: ParsedManifestLine[], rubbings: Rubbing[]): LoanManifestItem[] {
  const byCollection = new Map<string, Rubbing[]>();
  rubbings.forEach((rubbing) => {
    if (rubbing.collectionNo) {
      const key = normalizeNo(rubbing.collectionNo);
      byCollection.set(key, [...(byCollection.get(key) ?? []), rubbing]);
    }
  });

  const matchedRubbingIds = new Set<string>();

  return lines.map((line) => {
    let matchState: LoanMatchState = 'unclaimed';
    let rubbingId: string | null = null;

    if (line.collectionNo) {
      const candidates = (byCollection.get(normalizeNo(line.collectionNo)) ?? []).filter(
        (rubbing) => !matchedRubbingIds.has(rubbing.id),
      );
      if (candidates.length === 1) {
        matchState = 'matched';
        rubbingId = candidates[0]!.id;
      }
    }

    // 收藏号认不上（或多义）：展柜号原样保留，维持待认领，等人工凭展柜号认上。
    if (matchState === 'matched' && rubbingId) matchedRubbingIds.add(rubbingId);

    return {
      lineNo: line.lineNo,
      collectionNo: line.collectionNo,
      caseNo: line.caseNo,
      methodNote: line.methodNote,
      remark: line.remark,
      matchState,
      rubbingId,
      localWriteError: '',
      localRetryPending: false,
    };
  });
}

/** 人工把待认领条目指到某拓本（对账台「认上」操作） */
export function claimManifestItem(item: LoanManifestItem, rubbingId: string): LoanManifestItem {
  return { ...item, matchState: 'matched', rubbingId, localWriteError: '', localRetryPending: false };
}

/** 本侧单条写库结果：失败时只标记本侧重试，外馆字段原样保留 */
export interface LocalWriteOutcome {
  item: LoanManifestItem;
  ok: boolean;
  error: string;
}

export function markLocalWriteFailure(item: LoanManifestItem, error: string): LoanManifestItem {
  // 外馆原始字段（collectionNo / caseNo / methodNote / remark）一字不改
  return { ...item, localWriteError: error, localRetryPending: true };
}

export function markLocalWriteSuccess(item: LoanManifestItem): LoanManifestItem {
  return { ...item, localWriteError: '', localRetryPending: false };
}

/** 挑出需要重试本侧写库的条目（外馆那份不动） */
export function selectRetryableItems(items: LoanManifestItem[]): LoanManifestItem[] {
  return items.filter((item) => item.localRetryPending && item.matchState === 'matched');
}

/**
 * 状况记录归并：同一（manifestId + lineNo）以晚到的为准。
 * 不删除历史记录，只取 receivedAt 最大的一条作为当前状况；新损伤标记随该条保留在借展侧。
 */
export function latestConditions(conditions: LoanCondition[]): LoanCondition[] {
  const map = new Map<string, LoanCondition>();
  conditions.forEach((condition) => {
    const key = `${condition.manifestId}#${condition.lineNo}`;
    const current = map.get(key);
    if (!current || condition.receivedAt > current.receivedAt) {
      map.set(key, condition);
    }
  });
  return Array.from(map.values());
}

export function latestConditionFor(
  conditions: LoanCondition[],
  manifestId: string,
  lineNo: number,
): LoanCondition | null {
  const same = conditions
    .filter((condition) => condition.manifestId === manifestId && Number(condition.lineNo) === lineNo)
    .sort((a, b) => b.receivedAt - a.receivedAt);
  return same[0] ?? null;
}

/** 借展侧新损伤（绝不并入本馆 losses），供借展台单独列出 */
export function loanSideDamages(conditions: LoanCondition[]): LoanCondition[] {
  return latestConditions(conditions).filter((condition) => condition.hasNewDamage);
}
