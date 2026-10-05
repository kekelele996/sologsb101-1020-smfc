/**
 * 借展工具
 * - 点交单文本解析（每行「藏号 展柜号」）
 * - 点交单 / 借展记录排序：先收藏号，再展柜号
 * - 按藏号与本馆拓本对账
 * - 状况记录取晚到者为准
 */
import type { Loan, LoanConditionReport } from '@/types/loan';
import type { Rubbing } from '@/types/rubbing';

/** 点交单条目（解析结果，未对账） */
export interface HandoverEntryDraft {
  collectionNo: string;
  caseNo: string;
}

/** 先收藏号，再展柜号 */
export function compareHandoverKeys(a: HandoverEntryDraft, b: HandoverEntryDraft): number {
  const byNo = a.collectionNo.localeCompare(b.collectionNo, 'zh-Hans-CN', { numeric: true });
  if (byNo !== 0) return byNo;
  return a.caseNo.localeCompare(b.caseNo, 'zh-Hans-CN', { numeric: true });
}

export function sortHandoverEntries<T extends HandoverEntryDraft>(entries: T[]): T[] {
  return [...entries].sort(compareHandoverKeys);
}

export function sortLoans<T extends Pick<Loan, 'collectionNo' | 'caseNo'>>(loans: T[]): T[] {
  return [...loans].sort(compareHandoverKeys);
}

/**
 * 解析点交单文本：每行一条「藏号 展柜号」，分隔符支持逗号、顿号、分号、空白与制表符；
 * 空行与表头行（含「藏号」「展柜」字样）自动跳过，无法识别的行记入 skipped。
 */
export function parseHandoverText(text: string): { entries: HandoverEntryDraft[]; skipped: string[] } {
  const entries: HandoverEntryDraft[] = [];
  const skipped: string[] = [];
  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const tokens = line.split(/[,，、;；\s]+/).filter((token) => token.length > 0);
    const first = tokens[0];
    if (first === undefined) return;
    if (first.includes('藏号') || first.includes('展柜')) return;
    if (!/[\dA-Za-z一-龥]/.test(first)) {
      skipped.push(line);
      return;
    }
    entries.push({ collectionNo: first, caseNo: tokens[1] ?? '' });
  });
  return { entries: sortHandoverEntries(entries), skipped };
}

/** 按藏号对账：同藏号多份时取碑刻 id 与版本序号靠前者 */
export function matchRubbingByCollectionNo(rubbings: Rubbing[], collectionNo: string): Rubbing | null {
  const matched = rubbings.filter((rubbing) => rubbing.collectionNo === collectionNo);
  if (matched.length === 0) return null;
  const sorted = [...matched].sort((a, b) =>
    a.steleId === b.steleId ? a.versionNo - b.versionNo : a.steleId.localeCompare(b.steleId),
  );
  return sorted[0] ?? null;
}

/** 同一件以晚到的为准：取到达时间最晚的状况记录 */
export function latestReport(loan: Pick<Loan, 'reports'>): LoanConditionReport | null {
  if (loan.reports.length === 0) return null;
  return loan.reports.reduce((latest, report) => (report.receivedAt > latest.receivedAt ? report : latest));
}
