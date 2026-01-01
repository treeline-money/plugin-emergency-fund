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
  let expenseBreakdown = $state<{ tag: string; amount: number; percent: number }[]>([]);

  // UI State
  let showSetup = $state(false);

  // Settings form state
  let formTargetMonths = $state<number>(6);
  let formFundAllocations = $state<FundAllocation[]>([]);
  let formExpenseAccountIds = $state<string[]>([]);
  let formExcludedTags = $state<string[]>([]);
  let formLookbackMonths = $state(6);
  let formCalculationMethod = $state<"mean" | "median" | "trimmed_mean">("mean");
  let newTagInput = $state("");

  // Refs
  let containerEl = $state<HTMLDivElement | null>(null);

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

    if (!config) {
      showSetup = true;
    } else {
      await calculateRunway();
    }

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
        SELECT
          a.account_id,
          COALESCE(a.nickname, a.name) as account_name,
          a.account_type,
          COALESCE(latest.balance, a.balance, 0) as balance,
          a.institution_name
        FROM accounts a
        LEFT JOIN (
          SELECT account_id, balance
          FROM sys_balance_snapshots s1
          WHERE snapshot_time = (
            SELECT MAX(snapshot_time)
            FROM sys_balance_snapshots s2
            WHERE s2.account_id = s1.account_id
          )
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
          fundAllocations = Array.isArray(parsed) ? parsed : [];
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

  // Helper function to calculate fund balance from allocations
  async function calculateFundBalanceFromAllocations(allocations: FundAllocation[]): Promise<number> {
    if (allocations.length === 0) return 0;

    const accountIds = allocations.map(a => a.account_id);
    const placeholders = accountIds.map(() => '?').join(',');
    const balanceRows = await sdk.query<any>(`
      SELECT
        a.account_id,
        COALESCE(latest.balance, a.balance, 0) as balance
      FROM accounts a
      LEFT JOIN (
        SELECT account_id, balance
        FROM sys_balance_snapshots s1
        WHERE snapshot_time = (
          SELECT MAX(snapshot_time)
          FROM sys_balance_snapshots s2
          WHERE s2.account_id = s1.account_id
        )
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

        let tagFilter = "";
        if (config.excluded_tags.length > 0) {
          const tagConditions = config.excluded_tags.map(() => 'list_contains(tags, ?)').join(" OR ");
          tagFilter = `AND NOT (${tagConditions})`;
          params.push(...config.excluded_tags);
        }

        // Validate lookback_months is a safe integer
        const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(config.lookback_months) || 6)));

        const calcMethod = config.calculation_method === "median"
          ? "MEDIAN(total)"
          : config.calculation_method === "trimmed_mean"
          ? "AVG(total) FILTER (WHERE total BETWEEN (SELECT quantile_cont(total, 0.1) FROM monthly_totals) AND (SELECT quantile_cont(total, 0.9) FROM monthly_totals))"
          : "AVG(total)";

        const expenseQuery = `
          WITH monthly_totals AS (
            SELECT
              DATE_TRUNC('month', transaction_date) AS month,
              SUM(ABS(amount)) AS total
            FROM transactions
            WHERE amount < 0
              AND account_id IN (${accountPlaceholders})
              ${tagFilter}
              AND transaction_date >= CURRENT_DATE - INTERVAL '${lookbackMonths}' MONTH
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

      // Show ALL tags in breakdown (don't filter by excluded_tags here - that's only for the calculation)
      const rows = await sdk.query<any>(`
        WITH tagged_expenses AS (
          SELECT
            COALESCE(UNNEST(tags), 'Untagged') AS tag,
            ABS(amount) AS amount
          FROM transactions
          WHERE amount < 0
            AND account_id IN (${accountPlaceholders})
            AND transaction_date >= CURRENT_DATE - INTERVAL '${lookbackMonths}' MONTH
        ),
        totals AS (
          SELECT SUM(amount) as grand_total FROM tagged_expenses
        )
        SELECT
          tag,
          ROUND(SUM(amount) / ${lookbackMonths}, 2) AS monthly_avg,
          ROUND(SUM(amount) / (SELECT grand_total FROM totals) * 100, 1) AS pct
        FROM tagged_expenses
        GROUP BY tag
        ORDER BY monthly_avg DESC
      `, params);

      expenseBreakdown = rows.map((r: any) => ({
        tag: r[0],
        amount: r[1],
        percent: r[2],
      }));
    } catch (e) {
      expenseBreakdown = [];
    }
  }

  // Save config
  async function saveConfig() {
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

      await loadConfig();
      await calculateRunway();
      showSetup = false;
    } catch (e) {
      sdk.toast.error("Failed to save settings", e instanceof Error ? e.message : String(e));
    }
  }

  // Tag management
  function addExcludedTag(tag: string) {
    if (tag && !formExcludedTags.includes(tag)) {
      formExcludedTags = [...formExcludedTags, tag];
    }
    newTagInput = "";
  }

  function removeExcludedTag(tag: string) {
    formExcludedTags = formExcludedTags.filter((t) => t !== tag);
  }

  // Quick exclude from breakdown table
  async function quickExcludeTag(tag: string) {
    if (!config || tag === 'Untagged') return;

    const newExcludedTags = [...config.excluded_tags, tag];
    const excludedTagsJson = JSON.stringify(newExcludedTags);

    try {
      await sdk.execute(`
        UPDATE plugin_emergency_fund.config
        SET excluded_tags = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [excludedTagsJson, config.id]);

      await loadConfig();
      await calculateRunway();
      sdk.toast.info(`Excluded "${tag}" from expenses`);
    } catch (e) {
      sdk.toast.error("Failed to exclude tag", e instanceof Error ? e.message : String(e));
    }
  }

  // Account toggle
  function toggleExpenseAccount(accountId: string) {
    if (formExpenseAccountIds.includes(accountId)) {
      formExpenseAccountIds = formExpenseAccountIds.filter((id) => id !== accountId);
    } else {
      formExpenseAccountIds = [...formExpenseAccountIds, accountId];
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
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
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

    const sql = `-- Emergency Fund Expense Calculation
WITH monthly_totals AS (
  SELECT
    DATE_TRUNC('month', transaction_date) AS month,
    SUM(ABS(amount)) AS total
  FROM transactions
  WHERE amount < 0
    AND account_id IN (${accountFilter || "''"})
    ${tagFilter}
    AND transaction_date >= CURRENT_DATE - INTERVAL '${config.lookback_months}' MONTH
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
    if (showSetup) return;

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
  {:else if showSetup}
    <!-- Setup Screen - Modal-like card -->
    <div class="setup-screen">
      <div class="setup-card">
        <div class="setup-header">
          <h2>Configure Emergency Fund</h2>
        </div>

        <div class="setup-body">
          <!-- Step 1: Target -->
          <div class="setup-field">
            <label class="field-label">Target Runway</label>
            <div class="target-input">
              <input
                type="number"
                min="1"
                max="24"
                step="1"
                bind:value={formTargetMonths}
                class="number-input"
              />
              <span class="input-suffix">months of expenses</span>
            </div>
            <p class="field-hint">Most experts recommend 3-6 months</p>
          </div>

          <!-- Step 2: Fund Accounts -->
          <div class="setup-field">
            <label class="field-label">Emergency Fund Accounts</label>
            <p class="field-hint">Where is your emergency fund held?</p>
            <div class="account-list">
              {#each accounts as account}
                <label class="account-option">
                  <input
                    type="checkbox"
                    checked={formFundAllocations.some(a => a.account_id === account.account_id)}
                    onchange={() => toggleFundAccount(account.account_id)}
                  />
                  <span class="account-name">{account.account_name}</span>
                  <span class="account-balance">{formatCurrency(account.balance)}</span>
                </label>
              {/each}
            </div>
          </div>

        </div>

        <div class="setup-footer">
          <button
            class="btn primary"
            onclick={saveConfig}
          >
            Start Tracking
          </button>
        </div>
      </div>
    </div>
  {:else if runwayData}
    <!-- Calculator View -->
    <div class="calculator-view">
      <!-- Hero -->
      <div class="calc-hero" style="--status-color: {statusColor}">
        <span class="status-badge">{statusIcon}</span>
        <span class="runway-number">{runwayData.monthsOfRunway.toFixed(1)}</span>
        <span class="runway-label">months of runway</span>

        <div class="target-row">
          <span class="target-label">Target:</span>
          <select
            class="target-select"
            value={formTargetMonths}
            onchange={(e) => {
              formTargetMonths = Number(e.currentTarget.value);
              saveConfig();
            }}
          >
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={9}>9 months</option>
            <option value={12}>12 months</option>
          </select>
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
            {#each accounts as account}
              {@const allocation = formFundAllocations.find(a => a.account_id === account.account_id)}
              {@const isIncluded = !!allocation}
              <div class="calc-row-wrap" class:included={isIncluded}>
                <label class="calc-row">
                  <input
                    type="checkbox"
                    checked={isIncluded}
                    onchange={() => {
                      toggleFundAccount(account.account_id);
                      saveConfig();
                    }}
                  />
                  <span class="row-name">{account.account_name}</span>
                  <span class="row-balance">{formatCurrency(account.balance)}</span>
                </label>
                {#if isIncluded}
                  <div class="allocation-row">
                    <input
                      type="number"
                      class="alloc-input"
                      min="0"
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
              <label class="calc-row" class:excluded={isExcluded} class:included={!isExcluded}>
                <input
                  type="checkbox"
                  checked={!isExcluded}
                  disabled={item.tag === 'Untagged'}
                  onchange={() => {
                    if (isExcluded) {
                      formExcludedTags = formExcludedTags.filter(t => t !== item.tag);
                    } else {
                      formExcludedTags = [...formExcludedTags, item.tag];
                    }
                    saveConfig();
                  }}
                />
                <span class="row-name" class:muted={isExcluded}>{item.tag}</span>
                <span class="row-value" class:muted={isExcluded}>{formatCurrency(item.amount)}</span>
                <span class="row-pct" class:muted={isExcluded}>{item.percent}%</span>
              </label>
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

  /* Setup Screen - Modal-like card */
  .setup-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-primary);
  }

  .setup-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }

  .setup-header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--border-primary);
  }

  .setup-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .setup-body {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-height: 60vh;
    overflow-y: auto;
  }

  .setup-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .field-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
  }

  .setup-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border-primary);
    display: flex;
    justify-content: flex-end;
  }

  .more-accounts {
    margin-top: 8px;
    font-size: 12px;
  }

  .more-accounts summary {
    cursor: pointer;
    color: var(--text-muted);
    padding: 4px 0;
  }

  .more-accounts summary:hover {
    color: var(--accent-primary);
  }

  .account-type-badge {
    font-size: 10px;
    padding: 2px 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  /* Custom Checkbox */
  input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-primary);
    border-radius: 3px;
    background: var(--bg-primary);
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
  }

  input[type="checkbox"]:checked {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 4px;
    top: 1px;
    width: 4px;
    height: 8px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  input[type="checkbox"]:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
  }

  input[type="checkbox"]:hover:not(:checked) {
    border-color: var(--text-muted);
  }

  /* Account List */
  .account-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
  }

  .account-list.compact {
    max-height: 140px;
  }

  .account-option {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-primary);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .account-option:hover {
    background: var(--bg-tertiary);
  }

  .account-name {
    flex: 1;
  }

  .account-balance {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Target Input */
  .target-input {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .number-input {
    width: 80px;
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-mono);
  }

  .number-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .input-suffix {
    font-size: 13px;
    color: var(--text-muted);
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

  .target-select {
    padding: 8px;
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

  .target-select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .target-select option {
    background: var(--bg-secondary);
    color: var(--text-primary);
    padding: 8px;
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

  /* Expenses panel with sections */
  .expenses-panel {
    display: flex;
    flex-direction: column;
  }

  .panel-section {
    border-bottom: 1px solid var(--border-primary);
  }

  .panel-section:last-of-type {
    border-bottom: none;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section-header {
    padding: 8px 14px;
    background: var(--bg-tertiary);
  }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--text-muted);
  }

  .section-list {
    padding: 6px 8px;
    overflow-y: auto;
  }

  .panel-section:last-of-type .section-list {
    flex: 1;
  }

  .calc-row.compact {
    padding: 4px 6px;
  }

  .calc-row-wrap {
    border-radius: 4px;
    padding: 4px 6px;
  }

  .calc-row-wrap:hover {
    background: var(--bg-tertiary);
  }

  .calc-row-wrap.included {
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    margin-bottom: 4px;
    padding: 6px;
  }

  .calc-row {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13px;
  }

  .calc-row.excluded {
    opacity: 0.5;
  }

  .allocation-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    padding-left: 26px;
  }

  .alloc-input {
    width: 70px;
    padding: 4px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .alloc-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .alloc-type {
    padding: 4px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 12px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 4px center;
    padding-right: 20px;
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

  .row-name.muted {
    color: var(--text-muted);
  }

  .row-value {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .row-value.muted {
    color: var(--text-muted);
  }

  .row-pct {
    font-size: 11px;
    color: var(--text-muted);
    min-width: 32px;
    text-align: right;
  }

  .row-pct.muted {
    color: var(--text-muted);
  }

  .panel-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    border-top: 1px solid var(--border-primary);
  }

  .panel-footer.calc-settings {
    justify-content: flex-start;
    gap: 8px;
  }

  .inline-select {
    padding: 4px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 11px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 4px center;
    padding-right: 18px;
    cursor: pointer;
  }

  .inline-select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .inline-select option {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .footer-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .icon-btn {
    background: none;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    padding: 6px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
  }

  .icon-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .icon-btn.small {
    padding: 4px;
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    padding: 16px;
  }

  /* Keyboard Hints - removed from calculator view */
  .keyboard-hints {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 20px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-primary);
    font-size: 11px;
    color: var(--text-muted);
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .hint kbd {
    display: inline-block;
    padding: 2px 5px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
  }

  /* Tag chips */
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--accent-primary);
    color: white;
    border-radius: 4px;
    font-size: 11px;
  }

  .tag-remove {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    opacity: 0.8;
  }

  .tag-remove:hover {
    opacity: 1;
  }

  .select-input {
    width: 100%;
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

  .select-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .select-input option {
    background: var(--bg-secondary);
    color: var(--text-primary);
    padding: 8px;
  }

  .select-input.small {
    width: auto;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    width: 500px;
    max-width: 95vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--border-primary);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 16px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px;
    border-top: 1px solid var(--border-primary);
  }

  .settings-section {
    margin-bottom: 20px;
  }

  .settings-section h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  .setting-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 8px;
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .setting-row label {
    font-size: 13px;
    min-width: 80px;
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

  .btn.secondary {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
  }

  .btn.secondary:hover {
    background: var(--bg-primary);
  }

  .btn.danger {
    background: var(--accent-danger, #dc2626);
    color: white;
    font-size: 11px;
    padding: 4px 8px;
  }

  .btn.danger:hover {
    opacity: 0.9;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Required field styles */
  .required-badge {
    font-size: 10px;
    font-weight: 500;
    color: var(--accent-danger, #dc2626);
    margin-left: 4px;
  }

  .warning-text {
    font-size: 12px;
    color: var(--accent-danger, #dc2626);
    margin-top: 8px;
  }

</style>
