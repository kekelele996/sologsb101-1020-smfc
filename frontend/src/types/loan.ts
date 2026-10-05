/**
 * 借展（Loan）数据模型
 * 外馆点交单收下后生成的借展记录：藏号、展柜号、对账结果与展期状况记录。
 * 状况记录只挂在借展侧，新损伤不并入本馆损泐字位。
 */

/** 借展状态：借出中（已对上） / 待认领（认不上） */
export type LoanState = 'onLoan' | 'pendingClaim';

/** 展期状况记录（外馆发来，同一件以晚到的为准） */
export interface LoanConditionReport {
  id: string;
  /** 到达本馆的时间戳；同一件以晚到的为准 */
  receivedAt: number;
  /** 外馆来文日期 yyyy-MM-dd */
  reportDate: string;
  /** 状况描述 */
  condition: string;
  /** 新损伤（只记借展侧，不并入本馆损泐字位） */
  newDamage: string;
}

export interface Loan {
  id: string;
  /** 对上的本馆拓本 id；认不上为 null（待认领） */
  rubbingId: string | null;
  /** 藏号（点交单） */
  collectionNo: string;
  /** 展柜号（点交单） */
  caseNo: string;
  /** 借展外馆 */
  venue: string;
  /** 点交日期 yyyy-MM-dd */
  handoverDate: string;
  /** 借展状态 */
  state: LoanState;
  /** 展期状况记录（借展侧） */
  reports: LoanConditionReport[];
  createdAt: number;
  updatedAt: number;
}

export type LoanDraft = Omit<Loan, 'id' | 'createdAt' | 'updatedAt'>;

export const LOAN_STATE_LABEL: Record<LoanState, string> = {
  onLoan: '借出中',
  pendingClaim: '待认领',
};

export const LOAN_STATE_COLOR: Record<LoanState, string> = {
  onLoan: '#a33a2c',
  pendingClaim: '#c9963c',
};

export const LOAN_STATE_OPTIONS: ReadonlyArray<{ value: LoanState; label: string }> = [
  { value: 'onLoan', label: '借出中' },
  { value: 'pendingClaim', label: '待认领' },
];
