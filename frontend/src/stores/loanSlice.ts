/**
 * 借展 slice（Redux Toolkit）
 * 维护借展记录、点交单快照（外馆那份）与本侧写库失败待重试集合。
 * 点交单收下后按藏号对账：对上的挂借出标记（拓法等编目字段照旧），认不上的挂待认领；
 * 本馆写库失败后只重试本侧失败的几条，外馆点交单快照不动。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import type { Loan, LoanConditionReport, LoanState } from '@/types/loan';
import {
  matchRubbingByCollectionNo,
  sortHandoverEntries,
  sortLoans,
  type HandoverEntryDraft,
} from '@/utils/loan';
import { loadRubbings } from './rubbingSlice';
import type { RootState } from './store';

/** 点交单条目（收下时完成藏号对账，对账结果随快照保存，之后不动） */
export interface HandoverEntry extends HandoverEntryDraft {
  /** 批次内稳定序号，用于生成可重试的借展记录 id */
  entryId: string;
  /** 对上的本馆拓本 id；认不上为 null */
  rubbingId: string | null;
}

/** 点交单快照（外馆那份）：收下后原样保留，本侧重试不回改 */
export interface HandoverBatch {
  batchId: string;
  venue: string;
  handoverDate: string;
  receivedAt: number;
  entries: HandoverEntry[];
}

export interface LoanFilters {
  keyword: string;
  states: LoanState[];
}

export interface LoanSliceState {
  items: Loan[];
  loading: boolean;
  ready: boolean;
  error: string;
  filters: LoanFilters;
  /** 最近一次收下的点交单（外馆那份） */
  lastBatch: HandoverBatch | null;
  /** 本馆写库失败、待重试的本侧条目 */
  failedLocal: HandoverEntry[];
}

const initialState: LoanSliceState = {
  items: [],
  loading: false,
  ready: false,
  error: '',
  filters: { keyword: '', states: [] },
  lastBatch: null,
  failedLocal: [],
};

export const loadLoans = createAsyncThunk('loan/load', async () => {
  return sortLoans(await db.loans.toArray());
});

/** 单条点交条目落本馆库：借展记录 id 由批次与条目号决定，重试幂等不产生重复 */
async function applyHandoverEntry(batch: HandoverBatch, entry: HandoverEntry): Promise<void> {
  const now = Date.now();
  const loanId = `loan_${batch.batchId}_${entry.entryId}`;
  await db.transaction('rw', [db.loans, db.rubbings], async () => {
    const existing = await db.loans.get(loanId);
    const loan: Loan = existing
      ? // 已建档（重试）：保留借展侧已有的状况记录，只补本侧写库
        { ...existing, updatedAt: now }
      : {
          id: loanId,
          rubbingId: entry.rubbingId,
          collectionNo: entry.collectionNo,
          caseNo: entry.caseNo,
          venue: batch.venue,
          handoverDate: batch.handoverDate,
          state: entry.rubbingId ? 'onLoan' : 'pendingClaim',
          reports: [],
          createdAt: now,
          updatedAt: now,
        };
    await db.loans.put(loan);
    if (entry.rubbingId) {
      // 对上的只挂借出标记：编目员填的拓法、纸墨等字段照旧
      await db.rubbings.update(entry.rubbingId, { loanState: 'onLoan', updatedAt: now } as never);
    }
  });
}

/** 逐条写本馆库，失败的条目收集返回（外馆那份不动） */
async function applyHandoverEntries(batch: HandoverBatch, entries: HandoverEntry[]): Promise<HandoverEntry[]> {
  const failed: HandoverEntry[] = [];
  for (const entry of entries) {
    try {
      await applyHandoverEntry(batch, entry);
    } catch {
      failed.push(entry);
    }
  }
  return failed;
}

/** 收下点交单：排序对账后存快照，再逐条落本馆库 */
export const receiveHandoverList = createAsyncThunk(
  'loan/receiveHandover',
  async (payload: { venue: string; handoverDate: string; entries: HandoverEntryDraft[] }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const rubbings = state.rubbing.items;
    const sorted = sortHandoverEntries(payload.entries);
    const entries: HandoverEntry[] = sorted.map((entry, index) => ({
      ...entry,
      entryId: String(index + 1).padStart(3, '0'),
      rubbingId: matchRubbingByCollectionNo(rubbings, entry.collectionNo)?.id ?? null,
    }));
    const batch: HandoverBatch = {
      batchId: createId('hv'),
      venue: payload.venue,
      handoverDate: payload.handoverDate,
      receivedAt: Date.now(),
      entries,
    };
    const failed = await applyHandoverEntries(batch, entries);
    await dispatch(loadLoans());
    await dispatch(loadRubbings());
    return { batch, failed };
  },
);

/** 本馆写库失败后：只重试本侧失败的几条，外馆点交单快照不动 */
export const retryFailedLocal = createAsyncThunk('loan/retryFailedLocal', async (_, { dispatch, getState }) => {
  const { lastBatch, failedLocal } = (getState() as RootState).loan;
  if (!lastBatch || failedLocal.length === 0) return { failed: [] as HandoverEntry[] };
  const failed = await applyHandoverEntries(lastBatch, failedLocal);
  await dispatch(loadLoans());
  await dispatch(loadRubbings());
  return { failed };
});

/** 登记外馆发来的状况记录：同一件以晚到的为准；新损伤只记借展侧，不并入本馆损泐 */
export const receiveConditionReport = createAsyncThunk(
  'loan/receiveReport',
  async (payload: { loanId: string; reportDate: string; condition: string; newDamage: string }, { dispatch }) => {
    const loan = await db.loans.get(payload.loanId);
    if (!loan) throw new Error('借展记录不存在');
    const now = Date.now();
    const report: LoanConditionReport = {
      id: createId('lcr'),
      receivedAt: now,
      reportDate: payload.reportDate,
      condition: payload.condition,
      newDamage: payload.newDamage,
    };
    await db.loans.put({ ...loan, reports: [...loan.reports, report], updatedAt: now });
    await dispatch(loadLoans());
    return report;
  },
);

/** 认领待认领条目：补记对上的拓本并挂借出标记 */
export const claimLoan = createAsyncThunk(
  'loan/claim',
  async (payload: { loanId: string; rubbingId: string }, { dispatch }) => {
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.rubbings], async () => {
      const loan = await db.loans.get(payload.loanId);
      if (!loan) throw new Error('借展记录不存在');
      await db.loans.put({ ...loan, rubbingId: payload.rubbingId, state: 'onLoan', updatedAt: now });
      await db.rubbings.update(payload.rubbingId, { loanState: 'onLoan', updatedAt: now } as never);
    });
    await dispatch(loadLoans());
    await dispatch(loadRubbings());
  },
);

/** 销记借展记录：同时解除对应拓本的借出标记 */
export const removeLoan = createAsyncThunk('loan/remove', async (id: string, { dispatch }) => {
  const loan = await db.loans.get(id);
  await db.transaction('rw', [db.loans, db.rubbings], async () => {
    if (loan?.rubbingId) {
      await db.rubbings.update(loan.rubbingId, { loanState: 'none', updatedAt: Date.now() } as never);
    }
    await db.loans.delete(id);
  });
  await dispatch(loadLoans());
  await dispatch(loadRubbings());
});

const loanSlice = createSlice({
  name: 'loan',
  initialState,
  reducers: {
    setLoanKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setLoanStates(state, action: PayloadAction<LoanState[]>) {
      state.filters.states = action.payload;
    },
    resetLoanFilters(state) {
      state.filters = { keyword: '', states: [] };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLoans.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadLoans.fulfilled, (state, action) => {
        state.items = action.payload;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadLoans.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '借展记录读取失败';
      })
      .addCase(receiveHandoverList.fulfilled, (state, action) => {
        state.lastBatch = action.payload.batch;
        state.failedLocal = action.payload.failed;
      })
      .addCase(retryFailedLocal.fulfilled, (state, action) => {
        state.failedLocal = action.payload.failed;
      });
  },
});

export const { setLoanKeyword, setLoanStates, resetLoanFilters } = loanSlice.actions;

export const selectLoanState = (state: RootState): LoanSliceState => state.loan;
export const selectLoans = (state: RootState): Loan[] => state.loan.items;
export const selectFailedLocal = (state: RootState): HandoverEntry[] => state.loan.failedLocal;
export const selectLastBatch = (state: RootState): HandoverBatch | null => state.loan.lastBatch;

/** 派生选择器：关键字 + 借展状态筛选（列表保持先收藏号再展柜号） */
export function selectFilteredLoans(state: RootState): Loan[] {
  const { items, filters } = state.loan;
  const keyword = filters.keyword.trim();
  return items.filter((loan) => {
    if (keyword.length > 0) {
      const haystack = `${loan.collectionNo}${loan.caseNo}${loan.venue}`;
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.states.length > 0 && !filters.states.includes(loan.state)) return false;
    return true;
  });
}

/** 借展状态统计 */
export function selectLoanStats(state: RootState): { onLoan: number; pendingClaim: number; reports: number } {
  const items = state.loan.items;
  return {
    onLoan: items.filter((loan) => loan.state === 'onLoan').length,
    pendingClaim: items.filter((loan) => loan.state === 'pendingClaim').length,
    reports: items.reduce((sum, loan) => sum + loan.reports.length, 0),
  };
}

export default loanSlice.reducer;
