<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PluginSDK } from "@treeline-money/plugin-sdk";
  import type {
    EmergencyFundConfig,
    Account,
    RunwayData,
    FundAllocation,
  } from "./types";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();

  // State
  let isLoading = $state(true);
  let config = $state<EmergencyFundConfig | null>(null);
  let accounts = $state<Account[]>([]);
  let availableTags = $state<string[]>([]);
  let runwayData = $state<RunwayData | null>(null);
  let expenseBreakdown = $state<{ tag: string; amount: number; percent: number; isSystem?: boolean }[]>([]);


  // Settings form state
  let formTargetMonths = $state<number>(6);
  let formFundAllocations = $state<FundAllocation[]>([]);
  let formExpenseAccountIds = $state<string[]>([]);
  let formExcludedTags = $state<string[]>([]);
  let formLookbackMonths = $state(6);
  let formCalculationMethod = $state<"mean" | "median" | "trimmed_mean">("mean");

  // Refs
  let containerEl = $state<HTMLDivElement | null>(null);

  // Save guard to prevent race conditions
  let isSaving = $state(false);

  // Helper to compute lookback date (avoids ICU extension dependency)
  function getLookbackDate(months: number): string {
    const date = new Date();
    date.setMonth(date.getMonth() - months);
    return date.toISOString().split('T')[0];
  }

  // Lifecycle
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    unsubscribe = sdk.onDataRefresh(() => {
      loadData();
    });

    // Tables are created by migrations in index.ts - just load data
    await loadAccounts();
    await loadAvailableTags();
    await loadConfig();

    // Auto-create default config if none exists
    if (!config) {
      await createDefaultConfig();
    }

    await calculateRunway();
    isLoading = false;
    containerEl?.focus();
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Data loading
  async function loadAccounts() {
    try {
      // Get accounts with latest balance from snapshots (same pattern as goals plugin)
      const rows = await sdk.query<any>(`
        SELECT DISTINCT
          a.account_id,
          COALESCE(a.nickname, a.name) as account_name,
          a.account_type,
          COALESCE(latest.balance, a.balance, 0) as balance,
          a.institution_name
        FROM accounts a
        LEFT JOIN (
          SELECT DISTINCT ON (account_id) account_id, balance
          FROM sys_balance_snapshots
          ORDER BY account_id, snapshot_time DESC
        ) latest ON a.account_id = latest.account_id
        ORDER BY a.name
      `);
      accounts = rows.map((r: any) => ({
        account_id: r[0],
        account_name: r[1],
        account_type: r[2],
        balance: Number(r[3]) || 0,
        institution_name: r[4],
      }));
    } catch (e) {
      console.error("Failed to load accounts:", e);
      accounts = [];
    }
  }

  async function loadAvailableTags() {
    try {
      const rows = await sdk.query<any>(`
        SELECT DISTINCT UNNEST(tags) as tag
        FROM transactions
        WHERE tags IS NOT NULL AND LEN(tags) > 0
        ORDER BY tag
      `);
      availableTags = rows.map((r: any) => r[0] as string).filter(Boolean);
    } catch (e) {
      availableTags = [];
    }
  }

  async function loadConfig() {
    // Skip if a save is in progress to prevent race conditions
    if (isSaving) return;

    try {
      const rows = await sdk.query<any>(`
        SELECT id, linked_goal_id, target_months, target_months_override,
               fund_allocations, expense_account_ids, excluded_tags,
               lookback_months, calculation_method, created_at, updated_at
        FROM plugin_emergency_fund.config
        LIMIT 1
      `);
      if (rows.length > 0) {
        const r = rows[0];

        // Parse fund_allocations, handling both JSON string and already-parsed object
        let fundAllocations: FundAllocation[] = [];
        if (r[4]) {
          const parsed = typeof r[4] === 'string' ? JSON.parse(r[4]) : r[4];
          const rawAllocations = Array.isArray(parsed) ? parsed : [];
          // Deduplicate by account_id (keep first occurrence)
          const seen = new Set<string>();
          fundAllocations = rawAllocations.filter((a: FundAllocation) => {
            if (seen.has(a.account_id)) return false;
            seen.add(a.account_id);
            return true;
          });
        }

        config = {
          id: r[0],
          linked_goal_id: r[1],
          target_months: r[2],
          fund_allocations: fundAllocations,
          expense_account_ids: typeof r[5] === 'string' ? JSON.parse(r[5] || "[]") : (r[5] || []),
          excluded_tags: typeof r[6] === 'string' ? JSON.parse(r[6] || "[]") : (r[6] || []),
          lookback_months: r[7] || 6,
          calculation_method: r[8] || "mean",
          created_at: r[9],
          updated_at: r[10],
        };

        // Populate form state
        formTargetMonths = config.target_months ?? 6;
        formFundAllocations = [...config.fund_allocations];
        formExpenseAccountIds = [...config.expense_account_ids];
        formExcludedTags = [...config.excluded_tags];
        formLookbackMonths = config.lookback_months;
        formCalculationMethod = config.calculation_method;
      }
    } catch (e) {
      console.error("Failed to load config:", e);
      config = null;
    }
  }

  async function loadData() {
    await loadAccounts();
    await loadConfig();
    if (config) {
      await calculateRunway();
    }
  }

  async function createDefaultConfig() {
    try {
      await sdk.execute(`
        INSERT INTO plugin_emergency_fund.config
          (target_months, fund_allocations, expense_account_ids, excluded_tags, lookback_months, calculation_method)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [6, '[]', '[]', '[]', 6, 'mean']);
      await loadConfig();
    } catch (e) {
      console.error("Failed to create default config:", e);
    }
  }

  // Helper function to calculate fund balance from allocations
  async function calculateFundBalanceFromAllocations(allocations: FundAllocation[]): Promise<number> {
    if (allocations.length === 0) return 0;

    const accountIds = allocations.map(a => a.account_id);
    const placeholders = accountIds.map(() => '?').join(',');
    const balanceRows = await sdk.query<any>(`
      SELECT DISTINCT
        a.account_id,
        COALESCE(latest.balance, a.balance, 0) as balance
      FROM accounts a
      LEFT JOIN (
        SELECT DISTINCT ON (account_id) account_id, balance
        FROM sys_balance_snapshots
        ORDER BY account_id, snapshot_time DESC
      ) latest ON a.account_id = latest.account_id
      WHERE a.account_id IN (${placeholders})
    `, accountIds);

    let fundBalance = 0;
    for (const alloc of allocations) {
      const accountBalance = Number(balanceRows.find((r: any) => r[0] === alloc.account_id)?.[1]) || 0;
      if (alloc.allocation_type === 'percentage') {
        fundBalance += (accountBalance * alloc.allocation_value) / 100;
      } else {
        fundBalance += Math.min(alloc.allocation_value, accountBalance);
      }
    }
    return fundBalance;
  }

  // Calculate runway
  async function calculateRunway() {
    if (!config) return;

    try {
      // Get fund balance from allocations
      const fundBalance = await calculateFundBalanceFromAllocations(config.fund_allocations || []);

      // Get monthly expenses (use all accounts if none specified)
      let monthlyExpenses = 0;
      const expenseAccountIds = config.expense_account_ids.length > 0
        ? config.expense_account_ids
        : accounts.map(a => a.account_id);

      if (expenseAccountIds.length > 0) {
        const params: (string | number)[] = [];
        const accountPlaceholders = expenseAccountIds.map(() => '?').join(',');
        params.push(...expenseAccountIds);

        // Build tag filter - handle both regular tags and system untagged
        let tagFilter = "";
        const regularExcludedTags = config.excluded_tags.filter(t => t !== '__system__untagged');
        const excludeUntagged = config.excluded_tags.includes('__system__untagged');

        const conditions: string[] = [];
        if (regularExcludedTags.length > 0) {
          const tagConditions = regularExcludedTags.map(() => 'list_contains(tags, ?)').join(" OR ");
          conditions.push(`(${tagConditions})`);
          params.push(...regularExcludedTags);
        }
        if (excludeUntagged) {
          conditions.push('(tags IS NULL OR LEN(tags) = 0)');
        }
        if (conditions.length > 0) {
          tagFilter = `AND NOT (${conditions.join(' OR ')})`;
        }

        // Validate lookback_months is a safe integer
        const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(config.lookback_months) || 6)));

        const calcMethod = config.calculation_method === "median"
          ? "MEDIAN(total)"
          : config.calculation_method === "trimmed_mean"
          ? "AVG(total) FILTER (WHERE total BETWEEN (SELECT quantile_cont(total, 0.1) FROM monthly_totals) AND (SELECT quantile_cont(total, 0.9) FROM monthly_totals))"
          : "AVG(total)";

        // Compute lookback date in JS to avoid ICU extension dependency
        const lookbackDate = getLookbackDate(lookbackMonths);
        params.push(lookbackDate);

        const expenseQuery = `
          WITH monthly_totals AS (
            SELECT
              DATE_TRUNC('month', transaction_date) AS month,
              SUM(ABS(amount)) AS total
            FROM transactions
            WHERE amount < 0
              AND account_id IN (${accountPlaceholders})
              ${tagFilter}
              AND transaction_date >= ?::DATE
            GROUP BY month
          )
          SELECT ${calcMethod} AS monthly_avg
          FROM monthly_totals
        `;

        const expenseRows = await sdk.query<any>(expenseQuery, params);
        monthlyExpenses = expenseRows[0]?.[0] || 0;
      }

      // Calculate runway
      const monthsOfRunway = monthlyExpenses > 0 ? fundBalance / monthlyExpenses : 0;

      // Get target in months
      const targetMonths = config.target_months ?? 6;
      const targetAmount = monthlyExpenses * targetMonths;

      const progressPercent = targetAmount > 0 ? (fundBalance / targetAmount) * 100 : 0;
      const remainingToTarget = Math.max(0, targetAmount - fundBalance);

      // Status based on MONTHS of runway, not dollar progress
      const runwayPercent = targetMonths > 0 ? (monthsOfRunway / targetMonths) * 100 : 0;
      let status: "on-track" | "warning" | "critical" = "on-track";
      if (runwayPercent < 80) {
        status = runwayPercent < 50 ? "critical" : "warning";
      }

      runwayData = {
        fundBalance,
        monthlyExpenses,
        monthsOfRunway,
        targetMonths,
        targetAmount,
        progressPercent,
        remainingToTarget,
        status,
      };

      // Load expense breakdown
      await loadExpenseBreakdown();
    } catch (e) {
      sdk.toast.error("Failed to calculate runway", e instanceof Error ? e.message : String(e));
    }
  }

  async function loadExpenseBreakdown() {
    if (!config) {
      expenseBreakdown = [];
      return;
    }

    // Use all accounts if none specified
    const expenseAccountIds = config.expense_account_ids.length > 0
      ? config.expense_account_ids
      : accounts.map(a => a.account_id);

    if (expenseAccountIds.length === 0) {
      expenseBreakdown = [];
      return;
    }

    try {
      const params: (string | number)[] = [];
      const accountPlaceholders = expenseAccountIds.map(() => '?').join(',');
      params.push(...expenseAccountIds);

      // Validate lookback_months is a safe integer
      const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(config.lookback_months) || 6)));

      // Compute lookback date in JS to avoid ICU extension dependency
      const lookbackDate = getLookbackDate(lookbackMonths);
      params.push(lookbackDate);

      // Show ALL tags in breakdown including untagged transactions
      // Use special prefix __system__ to distinguish from user tags
      const rows = await sdk.query<any>(`
        WITH base_expenses AS (
          SELECT
            transaction_id,
            ABS(amount) AS amount,
            CASE WHEN tags IS NULL OR LEN(tags) = 0 THEN TRUE ELSE FALSE END AS is_untagged,
            tags
          FROM transactions
          WHERE amount < 0
            AND account_id IN (${accountPlaceholders})
            AND transaction_date >= ?::DATE
        ),
        tagged_expenses AS (
          -- Tagged transactions: one row per tag
          SELECT UNNEST(tags) AS tag, amount, FALSE AS is_system
          FROM base_expenses
          WHERE NOT is_untagged
          UNION ALL
          -- Untagged transactions: use special system identifier
          SELECT '__system__untagged' AS tag, amount, TRUE AS is_system
          FROM base_expenses
          WHERE is_untagged
        ),
        totals AS (
          SELECT SUM(amount) as grand_total FROM tagged_expenses
        )
        SELECT
          tag,
          ROUND(SUM(amount) / ${lookbackMonths}, 2) AS monthly_avg,
          ROUND(SUM(amount) / NULLIF((SELECT grand_total FROM totals), 0) * 100, 1) AS pct,
          MAX(CASE WHEN is_system THEN 1 ELSE 0 END) AS is_system
        FROM tagged_expenses
        GROUP BY tag
        ORDER BY is_system ASC, monthly_avg DESC
      `, params);

      expenseBreakdown = rows.map((r: any) => ({
        tag: r[0],
        amount: r[1],
        percent: r[2],
        isSystem: r[3] === 1,
      }));
    } catch (e) {
      expenseBreakdown = [];
    }
  }

  // Save config
  async function saveConfig() {
    // Prevent overlapping saves
    if (isSaving) return;
    isSaving = true;

    try {
      const allocationsJson = JSON.stringify(formFundAllocations);
      const expenseAccountsJson = JSON.stringify(formExpenseAccountIds);
      const excludedTagsJson = JSON.stringify(formExcludedTags);

      // Validate calculation_method against whitelist
      const validMethods = ["mean", "median", "trimmed_mean"];
      const calcMethod = validMethods.includes(formCalculationMethod) ? formCalculationMethod : "mean";

      // Validate lookback_months is a safe integer
      const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(formLookbackMonths) || 6)));

      if (config) {
        await sdk.execute(`
          UPDATE plugin_emergency_fund.config
          SET target_months = ?,
              fund_allocations = ?,
              expense_account_ids = ?,
              excluded_tags = ?,
              lookback_months = ?,
              calculation_method = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [
          formTargetMonths,
          allocationsJson,
          expenseAccountsJson,
          excludedTagsJson,
          lookbackMonths,
          calcMethod,
          config.id
        ]);
      } else {
        await sdk.execute(`
          INSERT INTO plugin_emergency_fund.config
            (target_months, fund_allocations, expense_account_ids, excluded_tags, lookback_months, calculation_method)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          formTargetMonths,
          allocationsJson,
          expenseAccountsJson,
          excludedTagsJson,
          lookbackMonths,
          calcMethod
        ]);
      }

      // Reset save guard before loading so loadConfig isn't blocked
      isSaving = false;
      await loadConfig();
      await calculateRunway();
    } catch (e) {
      sdk.toast.error("Failed to save settings", e instanceof Error ? e.message : String(e));
      isSaving = false;
    }
  }

  // Fund allocation management
  function addFundAllocation(accountId: string) {
    if (formFundAllocations.some(a => a.account_id === accountId)) return;
    formFundAllocations = [...formFundAllocations, {
      account_id: accountId,
      allocation_type: "percentage",
      allocation_value: 100,
    }];
  }

  function removeFundAllocation(accountId: string) {
    formFundAllocations = formFundAllocations.filter(a => a.account_id !== accountId);
  }

  function updateAllocation(accountId: string, field: 'allocation_type' | 'allocation_value', value: any) {
    formFundAllocations = formFundAllocations.map(a =>
      a.account_id === accountId ? { ...a, [field]: value } : a
    );
  }

  function toggleFundAccount(accountId: string) {
    if (formFundAllocations.some(a => a.account_id === accountId)) {
      removeFundAllocation(accountId);
    } else {
      addFundAllocation(accountId);
    }
  }

  // Get account name helper
  function getAccountName(accountId: string): string {
    return accounts.find(a => a.account_id === accountId)?.account_name ?? accountId;
  }

  function getAccountBalance(accountId: string): number {
    return accounts.find(a => a.account_id === accountId)?.balance ?? 0;
  }

  // Formatting
  function formatCurrency(amount: number): string {
    return sdk.currency.format(amount);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // View SQL
  function viewSQL() {
    if (!config) return;

    const accountFilter = config.expense_account_ids.map((id) => `'${id}'`).join(",");
    let tagFilter = "";
    if (config.excluded_tags.length > 0) {
      const tagConditions = config.excluded_tags
        .map((tag) => `list_contains(tags, '${tag}')`)
        .join(" OR ");
      tagFilter = `AND NOT (${tagConditions})`;
    }

    // Use a literal date instead of CURRENT_DATE to avoid ICU extension dependency
    const lookbackDate = getLookbackDate(config.lookback_months);

    const sql = `-- Emergency Fund Expense Calculation
WITH monthly_totals AS (
  SELECT
    DATE_TRUNC('month', transaction_date) AS month,
    SUM(ABS(amount)) AS total
  FROM transactions
  WHERE amount < 0
    AND account_id IN (${accountFilter || "''"})
    ${tagFilter}
    AND transaction_date >= '${lookbackDate}'
  GROUP BY month
)
SELECT
  month,
  total,
  AVG(total) OVER () as avg_monthly
FROM monthly_totals
ORDER BY month DESC`;

    sdk.openView("query", { initialQuery: sql });
  }

  // Keyboard navigation
  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "r":
        e.preventDefault();
        loadData();
        break;
      case "v":
        e.preventDefault();
        viewSQL();
        break;
    }
  }

  // Derived
  let statusColor = $derived(
    runwayData?.status === "on-track"
      ? "var(--accent-success)"
      : runwayData?.status === "warning"
      ? "var(--accent-warning, #f0a020)"
      : "var(--accent-danger)"
  );
  let statusIcon = $derived(
    runwayData?.status === "on-track" ? "✓" : runwayData?.status === "warning" ? "⚠" : "⚡"
  );

  // Sort accounts with selected ones at top (based on persisted config, not form state)
  let sortedAccounts = $derived(
    [...accounts].sort((a, b) => {
      const savedAllocations = config?.fund_allocations ?? [];
      const aSelected = savedAllocations.some(f => f.account_id === a.account_id);
      const bSelected = savedAllocations.some(f => f.account_id === b.account_id);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return a.account_name.localeCompare(b.account_name);
    })
  );
</script>

<div
  class="emergency-fund-view"
  bind:this={containerEl}
  onkeydown={handleKeyDown}
  tabindex="-1"
  role="application"
>
  {#if isLoading}
    <div class="loading">
      <div class="spinner"></div>
      <span>Loading emergency fund data...</span>
    </div>
  {:else}
    <!-- Calculator View -->
    <div class="calculator-view">
      <!-- Hero -->
      <div class="calc-hero" style="--status-color: {statusColor}">
        <span class="status-badge">{statusIcon}</span>
        <span class="runway-number">{runwayData.monthsOfRunway.toFixed(1)}</span>
        <span class="runway-label">months of runway</span>

        <div class="target-row">
          <span class="target-label">Target:</span>
          <input
            type="number"
            class="target-input"
            min="1"
            max="24"
            value={formTargetMonths}
            onchange={(e) => {
              formTargetMonths = Math.max(1, Math.min(24, Number(e.currentTarget.value) || 6));
              saveConfig();
            }}
          />
          <span class="target-suffix">months</span>
          <div class="target-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {Math.min(runwayData.progressPercent, 100)}%"></div>
            </div>
            <span class="progress-pct">{runwayData.progressPercent.toFixed(0)}%</span>
          </div>
        </div>

        {#if runwayData.remainingToTarget > 0}
          <span class="target-gap">{formatCurrency(runwayData.remainingToTarget)} to go</span>
        {:else}
          <span class="target-met">Target reached!</span>
        {/if}
      </div>

      <!-- Two Column Calculator -->
      <div class="calc-panels">
        <!-- Fund Panel -->
        <div class="calc-panel">
          <div class="panel-header">
            <span class="panel-title">Emergency Fund</span>
            <span class="panel-total">{formatCurrency(runwayData.fundBalance)}</span>
          </div>
          <div class="panel-list">
            {#each sortedAccounts as account (account.account_id)}
              {@const allocation = formFundAllocations.find(a => a.account_id === account.account_id)}
              {@const isIncluded = !!allocation}
              <div class="fund-account-row" class:included={isIncluded}>
                <label class="fund-account-main">
                  <input
                    type="checkbox"
                    checked={isIncluded}
                    onchange={() => {
                      toggleFundAccount(account.account_id);
                      saveConfig();
                    }}
                  />
                  <span class="account-info">
                    <span class="row-name">{account.account_name}</span>
                    <span class="row-balance">{formatCurrency(account.balance)}</span>
                  </span>
                </label>
                {#if isIncluded}
                  <div class="allocation-controls">
                    <span class="alloc-label">Use</span>
                    <input
                      type="number"
                      class="alloc-input"
                      min="0"
                      max={allocation.allocation_type === 'percentage' ? 100 : undefined}
                      value={allocation.allocation_value}
                      onchange={(e) => {
                        updateAllocation(account.account_id, 'allocation_value', Number(e.currentTarget.value));
                        saveConfig();
                      }}
                    />
                    <select
                      class="alloc-type"
                      value={allocation.allocation_type}
                      onchange={(e) => {
                        updateAllocation(account.account_id, 'allocation_type', e.currentTarget.value);
                        saveConfig();
                      }}
                    >
                      <option value="percentage">%</option>
                      <option value="fixed">$</option>
                    </select>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <!-- Expenses Panel -->
        <div class="calc-panel">
          <div class="panel-header">
            <span class="panel-title">Monthly Expenses</span>
            <span class="panel-total">{formatCurrency(runwayData.monthlyExpenses)}/mo</span>
          </div>
          <div class="calc-settings-bar">
            <select
              class="calc-select"
              value={formLookbackMonths}
              onchange={(e) => {
                formLookbackMonths = Number(e.currentTarget.value);
                saveConfig();
              }}
            >
              <option value={3}>Last 3 months</option>
              <option value={6}>Last 6 months</option>
              <option value={12}>Last 12 months</option>
            </select>
            <select
              class="calc-select"
              value={formCalculationMethod}
              onchange={(e) => {
                formCalculationMethod = e.currentTarget.value as "mean" | "median" | "trimmed_mean";
                saveConfig();
              }}
            >
              <option value="mean">Average</option>
              <option value="median">Median</option>
              <option value="trimmed_mean">Trimmed Avg</option>
            </select>
          </div>
          <div class="panel-list">
            {#each expenseBreakdown as item}
              {@const isExcluded = formExcludedTags.includes(item.tag)}
              {@const displayTag = item.isSystem ? 'No tag' : item.tag}
              <div class="expense-row" class:excluded={isExcluded} class:system-row={item.isSystem}>
                <label class="expense-row-main">
                  <input
                    type="checkbox"
                    checked={!isExcluded}
                    onchange={() => {
                      if (isExcluded) {
                        formExcludedTags = formExcludedTags.filter(t => t !== item.tag);
                      } else {
                        formExcludedTags = [...formExcludedTags, item.tag];
                      }
                      saveConfig();
                    }}
                  />
                  <span class="expense-info">
                    <span class="expense-tag" class:excluded={isExcluded} class:system-tag={item.isSystem}>{displayTag}</span>
                    {#if isExcluded}
                      <span class="excluded-badge">excluded</span>
                    {/if}
                  </span>
                  <span class="expense-amount" class:excluded={isExcluded}>{formatCurrency(item.amount)}</span>
                  <span class="expense-pct" class:excluded={isExcluded}>{item.percent}%</span>
                </label>
              </div>
            {/each}
            {#if expenseBreakdown.length === 0}
              <p class="empty-hint">No expense data found</p>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .emergency-fund-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    outline: none;
  }

  /* Loading */
  .loading {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-muted);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-primary);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Custom Checkbox */
  input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    transition: all 0.15s ease;
  }

  input[type="checkbox"]:checked {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 5px;
    top: 2px;
    width: 5px;
    height: 9px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  input[type="checkbox"]:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.25);
  }

  input[type="checkbox"]:hover:not(:checked):not(:disabled) {
    border-color: var(--accent-primary);
    background: var(--bg-tertiary);
  }

  input[type="checkbox"]:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Calculator View */
  .calculator-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 20px;
    gap: 20px;
    overflow-y: auto;
  }

  /* Hero */
  .calc-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 24px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 12px;
  }

  .status-badge {
    font-size: 20px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .runway-number {
    font-size: 56px;
    font-weight: 700;
    font-family: var(--font-mono);
    line-height: 1;
    color: var(--status-color);
  }

  .runway-label {
    font-size: 14px;
    color: var(--text-muted);
    margin-bottom: 16px;
  }

  .target-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 320px;
  }

  .target-label {
    font-size: 13px;
    color: var(--text-muted);
  }

  .target-input {
    width: 50px;
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-mono);
    text-align: center;
    -moz-appearance: textfield;
  }

  .target-input::-webkit-outer-spin-button,
  .target-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .target-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .target-suffix {
    font-size: 13px;
    color: var(--text-muted);
  }

  .target-progress {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .target-progress .progress-bar {
    flex: 1;
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .target-progress .progress-fill {
    height: 100%;
    background: var(--status-color);
    border-radius: 3px;
    transition: width 0.2s;
  }

  .progress-pct {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    min-width: 36px;
    text-align: right;
  }

  .target-gap {
    margin-top: 12px;
    font-size: 13px;
    color: var(--text-muted);
  }

  .target-met {
    margin-top: 12px;
    font-size: 13px;
    color: var(--accent-success);
    font-weight: 500;
  }

  /* Two Column Panels */
  .calc-panels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 700px) {
    .calc-panels {
      grid-template-columns: 1fr;
    }
  }

  .calc-panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-primary);
  }

  .panel-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--text-muted);
  }

  .panel-total {
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  .panel-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .calc-settings-bar {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-primary);
  }

  .calc-select {
    flex: 1;
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .calc-select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .calc-select option {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Fund Account Row */
  .fund-account-row {
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 4px;
    transition: background 0.15s ease;
  }

  .fund-account-row:hover {
    background: var(--bg-tertiary);
  }

  .fund-account-row.included {
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
  }

  .fund-account-main {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13px;
  }

  .account-info {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .allocation-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding-left: 28px;
  }

  .alloc-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .alloc-input {
    width: 60px;
    padding: 5px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono);
    text-align: right;
    /* Hide native number spinners */
    -moz-appearance: textfield;
  }

  .alloc-input::-webkit-outer-spin-button,
  .alloc-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .alloc-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .alloc-type {
    padding: 5px 24px 5px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 500;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    cursor: pointer;
  }

  .alloc-type:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .alloc-type option {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Expense Row */
  .expense-row {
    border-radius: 6px;
    padding: 6px 8px;
    margin-bottom: 2px;
    transition: all 0.15s ease;
  }

  .expense-row:hover {
    background: var(--bg-tertiary);
  }

  .expense-row.excluded {
    opacity: 0.6;
  }

  .expense-row-main {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13px;
  }

  .expense-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .expense-tag {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .expense-tag.excluded {
    text-decoration: line-through;
    color: var(--text-muted);
  }

  .expense-tag.system-tag {
    font-style: italic;
    color: var(--text-muted);
  }

  .system-row {
    border-top: 1px solid var(--border-primary);
    margin-top: 4px;
    padding-top: 8px;
  }

  .excluded-badge {
    font-size: 10px;
    padding: 2px 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }

  .expense-amount {
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: right;
    min-width: 70px;
  }

  .expense-amount.excluded {
    color: var(--text-muted);
  }

  .expense-pct {
    font-size: 11px;
    color: var(--text-muted);
    min-width: 36px;
    text-align: right;
  }

  .expense-pct.excluded {
    color: var(--text-muted);
  }

  .row-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-balance {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    padding: 16px;
  }

  /* Buttons */
  .btn {
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
  }

  .btn.primary {
    background: var(--accent-primary);
    color: white;
  }

  .btn.primary:hover {
    opacity: 0.9;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

</style>
