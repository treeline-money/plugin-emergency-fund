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
  let showSettings = $state(false);
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

      // Get monthly expenses
      let monthlyExpenses = 0;

      if (config.expense_account_ids.length > 0) {
        const params: (string | number)[] = [];
        const accountPlaceholders = config.expense_account_ids.map(() => '?').join(',');
        params.push(...config.expense_account_ids);

        let tagFilter = "";
        if (config.excluded_tags.length > 0) {
          const tagConditions = config.excluded_tags.map(() => 'list_contains(tags, ?)').join(" OR ");
          tagFilter = `AND NOT (${tagConditions})`;
          params.push(...config.excluded_tags);
        }

        // Validate lookback_months is a safe integer
        const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(config.lookback_months) || 6)));

        const calcMethod = config.calculation_method === "median"
          ? "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total)"
          : config.calculation_method === "trimmed_mean"
          ? "AVG(total) FILTER (WHERE total BETWEEN (SELECT PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY total) FROM monthly_totals) AND (SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total) FROM monthly_totals))"
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
    if (!config || config.expense_account_ids.length === 0) {
      expenseBreakdown = [];
      return;
    }

    try {
      const params: (string | number)[] = [];
      const accountPlaceholders = config.expense_account_ids.map(() => '?').join(',');
      params.push(...config.expense_account_ids);

      let tagFilter = "";
      if (config.excluded_tags.length > 0) {
        const tagConditions = config.excluded_tags.map(() => 'list_contains(tags, ?)').join(" OR ");
        tagFilter = `AND NOT (${tagConditions})`;
        params.push(...config.excluded_tags);
      }

      // Validate lookback_months is a safe integer
      const lookbackMonths = Math.max(1, Math.min(120, Math.floor(Number(config.lookback_months) || 6)));

      const rows = await sdk.query<any>(`
        WITH tagged_expenses AS (
          SELECT
            COALESCE(UNNEST(tags), 'Untagged') AS tag,
            ABS(amount) AS amount
          FROM transactions
          WHERE amount < 0
            AND account_id IN (${accountPlaceholders})
            ${tagFilter}
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
      showSettings = false;
      showSetup = false;
      sdk.toast.success("Settings saved");
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
    if (showSettings || showSetup) return;

    switch (e.key) {
      case "s":
        e.preventDefault();
        showSettings = true;
        break;
      case "r":
        e.preventDefault();
        loadData();
        break;
      case "v":
        e.preventDefault();
        viewSQL();
        break;
      case "Escape":
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
              {#each accounts.filter(a => ['checking', 'savings', 'money_market'].includes(a.account_type?.toLowerCase() || '')) as account}
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
              {#if accounts.filter(a => !['checking', 'savings', 'money_market'].includes(a.account_type?.toLowerCase() || '')).length > 0}
                <details class="more-accounts">
                  <summary>Other accounts</summary>
                  {#each accounts.filter(a => !['checking', 'savings', 'money_market'].includes(a.account_type?.toLowerCase() || '')) as account}
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
                </details>
              {/if}
            </div>
          </div>

          <!-- Step 3: Expense Accounts -->
          <div class="setup-field">
            <label class="field-label">Expense Accounts <span class="required-badge">Required</span></label>
            <p class="field-hint">Which accounts do you spend from?</p>
            <div class="account-list">
              {#each accounts as account}
                <label class="account-option">
                  <input
                    type="checkbox"
                    checked={formExpenseAccountIds.includes(account.account_id)}
                    onchange={() => toggleExpenseAccount(account.account_id)}
                  />
                  <span class="account-name">{account.account_name}</span>
                  <span class="account-type-badge">{account.account_type}</span>
                </label>
              {/each}
            </div>
            {#if formExpenseAccountIds.length === 0}
              <p class="warning-text">Select at least one expense account</p>
            {/if}
          </div>
        </div>

        <div class="setup-footer">
          <button
            class="btn primary"
            onclick={saveConfig}
            disabled={formExpenseAccountIds.length === 0}
          >
            Start Tracking
          </button>
        </div>
      </div>
    </div>
  {:else if runwayData}
    <!-- Main View -->
    <header class="header">
      <div class="title-row">
        <h1 class="title">Emergency Fund</h1>
        <div class="header-spacer"></div>
        <button class="icon-btn" onclick={() => showSettings = true} title="Settings (s)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="icon-btn" onclick={() => loadData()} title="Refresh (r)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>

      <!-- Hero Cards - Equal sizing grid -->
      <div class="hero-cards">
        <div class="hero-card runway" style="--status-color: {statusColor}">
          <span class="hero-label">Runway</span>
          <span class="hero-value">
            <span class="status-icon">{statusIcon}</span>
            {runwayData.monthsOfRunway.toFixed(1)}
          </span>
          <span class="hero-unit">months</span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Current Fund</span>
          <span class="hero-value">{formatCurrency(runwayData.fundBalance)}</span>
          <span class="hero-unit">saved</span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Monthly Spend</span>
          <span class="hero-value">{formatCurrency(runwayData.monthlyExpenses)}</span>
          <span class="hero-unit">{config?.lookback_months}mo avg</span>
        </div>
      </div>

      <!-- Progress Bar -->
      <div class="progress-section">
        <div class="progress-header">
          <span class="progress-title">Target: {runwayData.targetMonths} months ({formatCurrency(runwayData.targetAmount)})</span>
          <span class="progress-pct">{runwayData.progressPercent.toFixed(0)}%</span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: {Math.min(runwayData.progressPercent, 100)}%; background: {statusColor}"
          ></div>
        </div>
        {#if runwayData.remainingToTarget > 0}
          <span class="progress-remaining">{formatCurrency(runwayData.remainingToTarget)} to go</span>
        {:else}
          <span class="progress-remaining success">Target reached!</span>
        {/if}
      </div>
    </header>

    <div class="main-content">
      <!-- Expense Breakdown - Full width -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Expense Breakdown</h2>
          <button class="sql-link" onclick={viewSQL}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            View SQL
          </button>
        </div>
        <p class="section-hint">
          Based on {config?.lookback_months}-month {config?.calculation_method === "median" ? "median" : config?.calculation_method === "trimmed_mean" ? "trimmed avg" : "average"}
          {#if config?.excluded_tags && config.excluded_tags.length > 0}
            • Excludes: {config.excluded_tags.join(", ")}
          {/if}
        </p>

        {#if expenseBreakdown.length > 0}
          <div class="breakdown-table">
            <div class="breakdown-header">
              <span>Category</span>
              <span>Monthly</span>
              <span>Share</span>
              <span>Runway</span>
            </div>
            {#each expenseBreakdown as item}
              <div class="breakdown-row">
                <span class="breakdown-tag">
                  {item.tag}
                  {#if item.tag !== 'Untagged'}
                    <button
                      class="exclude-btn"
                      onclick={() => quickExcludeTag(item.tag)}
                      title="Exclude from calculation"
                    >×</button>
                  {/if}
                </span>
                <span class="breakdown-amount">{formatCurrency(item.amount)}</span>
                <span class="breakdown-percent">{item.percent}%</span>
                <span class="breakdown-runway">
                  {(runwayData.fundBalance / item.amount).toFixed(1)} mo
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="empty-hint">No expense data available. Make sure you have transactions in your expense accounts.</p>
        {/if}
      </section>

    </div>

    <!-- Keyboard Hints -->
    <footer class="keyboard-hints">
      <span class="hint"><kbd>s</kbd> settings</span>
      <span class="hint"><kbd>r</kbd> refresh</span>
      <span class="hint"><kbd>v</kbd> view SQL</span>
    </footer>
  {/if}
</div>

<!-- Settings Modal -->
{#if showSettings}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showSettings = false}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>Settings</h3>
        <button class="close-btn" onclick={() => showSettings = false}>×</button>
      </div>

      <div class="modal-body">
        <!-- Target Months -->
        <div class="settings-section">
          <h4>Target Runway</h4>
          <div class="target-input">
            <input
              type="number"
              min="1"
              max="24"
              step="1"
              bind:value={formTargetMonths}
              class="number-input"
            />
            <span class="input-suffix">months</span>
          </div>
        </div>

        <!-- Fund Accounts -->
        <div class="settings-section">
          <h4>Emergency Fund Accounts</h4>
          <p class="setting-hint">Where is your emergency fund held?</p>
          <div class="account-list compact">
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

        <!-- Expense Accounts -->
        <div class="settings-section">
          <h4>Expense Accounts</h4>
          <p class="setting-hint">Which accounts do you spend from?</p>
          <div class="account-list compact">
            {#each accounts as account}
              <label class="account-option">
                <input
                  type="checkbox"
                  checked={formExpenseAccountIds.includes(account.account_id)}
                  onchange={() => toggleExpenseAccount(account.account_id)}
                />
                <span class="account-name">{account.account_name}</span>
              </label>
            {/each}
          </div>
        </div>

        <!-- Exclude Tags -->
        <div class="settings-section">
          <h4>Exclude Tags</h4>
          <p class="setting-hint">Exclude certain expense categories from the calculation</p>
          <select
            class="select-input"
            bind:value={newTagInput}
            onchange={() => { if (newTagInput) addExcludedTag(newTagInput); }}
          >
            <option value="">Select a tag to exclude...</option>
            {#each availableTags.filter(t => !formExcludedTags.includes(t)) as tag}
              <option value={tag}>{tag}</option>
            {/each}
          </select>
          {#if formExcludedTags.length > 0}
            <div class="tag-list">
              {#each formExcludedTags as tag}
                <span class="tag-chip">
                  {tag}
                  <button class="tag-remove" onclick={() => removeExcludedTag(tag)}>×</button>
                </span>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Calculation Settings -->
        <div class="settings-section">
          <h4>Calculation</h4>
          <div class="setting-row">
            <label for="lookback">Lookback:</label>
            <select id="lookback" bind:value={formLookbackMonths} class="select-input small">
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="method">Method:</label>
            <select id="method" bind:value={formCalculationMethod} class="select-input small">
              <option value="mean">Average</option>
              <option value="median">Median</option>
              <option value="trimmed_mean">Trimmed Average</option>
            </select>
          </div>
          <p class="setting-hint">Trimmed average removes unusually high/low months.</p>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn secondary" onclick={() => showSettings = false}>Cancel</button>
        <button class="btn primary" onclick={saveConfig}>Save</button>
      </div>
    </div>
  </div>
{/if}

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

  /* Header */
  .header {
    padding: 16px 20px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  .header-spacer {
    flex: 1;
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

  /* Hero Cards - Grid layout */
  .hero-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 16px;
  }

  .hero-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hero-card.runway {
    border-left: 4px solid var(--status-color);
  }

  .hero-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .hero-value {
    font-size: 24px;
    font-weight: 600;
    font-family: var(--font-mono);
    line-height: 1.2;
  }

  .hero-unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  .status-icon {
    margin-right: 4px;
    font-size: 16px;
  }

  /* Progress */
  .progress-section {
    margin-top: 16px;
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .progress-title {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .progress-pct {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .progress-bar {
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-remaining {
    font-size: 11px;
    color: var(--text-muted);
    display: block;
    margin-top: 4px;
  }

  .progress-remaining.success {
    color: var(--accent-success);
  }

  /* Main Content */
  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 16px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }

  .section-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin: 0 0 12px 0;
  }

  .sql-link {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
  }

  .sql-link:hover {
    background: var(--bg-tertiary);
    color: var(--accent-primary);
  }

  /* Breakdown Table */
  .breakdown-table {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .breakdown-header {
    display: grid;
    grid-template-columns: 1fr 90px 60px 70px;
    gap: 12px;
    padding: 8px 0;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    border-bottom: 2px solid var(--border-primary);
  }

  .breakdown-header span:not(:first-child) {
    text-align: right;
  }

  .breakdown-row {
    display: grid;
    grid-template-columns: 1fr 90px 60px 70px;
    gap: 12px;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-primary);
  }

  .breakdown-row:last-child {
    border-bottom: none;
  }

  .breakdown-tag {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .breakdown-amount {
    font-family: var(--font-mono);
    font-size: 13px;
    text-align: right;
  }

  .breakdown-percent {
    font-size: 12px;
    color: var(--text-muted);
    text-align: right;
  }

  .breakdown-runway {
    font-size: 12px;
    color: var(--text-muted);
    text-align: right;
  }

  .exclude-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 4px;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.15s;
    line-height: 1;
  }

  .breakdown-row:hover .exclude-btn {
    opacity: 0.5;
  }

  .exclude-btn:hover {
    opacity: 1;
    color: var(--accent-danger);
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    padding: 24px;
  }

  /* Keyboard Hints */
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
