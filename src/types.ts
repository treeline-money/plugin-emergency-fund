/**
 * Emergency Fund Plugin Types
 *
 * Plugin-specific types. SDK types are imported from @treeline-money/plugin-sdk
 */

export interface FundAllocation {
  account_id: string;
  allocation_type: "percentage" | "fixed";
  allocation_value: number;
}

export interface EmergencyFundConfig {
  id: string;
  linked_goal_id: string | null;
  target_months: number | null;  // null = auto-calculate from goal
  fund_allocations: FundAllocation[];  // for manual mode
  expense_account_ids: string[];
  excluded_tags: string[];
  lookback_months: number;
  calculation_method: "mean" | "median" | "trimmed_mean";
  created_at: string;
  updated_at: string;
}

export interface EmergencyFundSnapshot {
  snapshot_id: string;
  snapshot_date: string;
  fund_balance: number;
  monthly_expenses: number;
  months_of_runway: number;
  notes: string | null;
  created_at: string;
}

export interface Account {
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
  institution_name: string;
}

export interface Goal {
  id: string;
  name: string;
  target_amount: number;
  allocations: string; // JSON string
  icon: string;
  active: boolean;
}

export interface RunwayData {
  fundBalance: number;
  monthlyExpenses: number;
  monthsOfRunway: number;
  targetMonths: number;
  targetAmount: number;
  progressPercent: number;
  remainingToTarget: number;
  status: "on-track" | "warning" | "critical";
}
