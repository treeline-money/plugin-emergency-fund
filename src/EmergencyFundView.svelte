<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    PluginSDK,
    EmergencyFundConfig,
    EmergencyFundSnapshot,
    Account,
    Goal,
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
  let goals = $state<Goal[]>([]);
  let snapshots = $state<EmergencyFundSnapshot[]>([]);
  let availableTags = $state<string[]>([]);
  let runwayData = $state<RunwayData | null>(null);
  let expenseBreakdown = $state<{ tag: string; amount: number; percent: number }[]>([]);
  let autoTargetMonths = $state<number | null>(null);  // calculated from goal's dollar target

  // UI State
  let showSettings = $state(false);
  let showSetup = $state(false);
  let selectedSnapshotIndex = $state(-1);

  // Settings form state
  let formLinkedGoalId = $state<string | null>(null);
  let formTargetMonths = $state<number>(6);  // target in months
  let formTargetMonthsOverride = $state(false);  // true if user manually set (when linked to goal)
  let formFundAllocations = $state<FundAllocation[]>([]);  // manual mode allocations
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

    await ensureTables();
    await loadAccounts();
    await loadGoals();
    await loadAvailableTags();
    await loadConfig();
    await loadSnapshots();

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

  // Database setup
  async function ensureTables() {
    try {
      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_emergency_fund_config (
          id VARCHAR PRIMARY KEY DEFAULT (uuid()),
          linked_goal_id VARCHAR,
          target_months DECIMAL(4,1),
          target_months_override BOOLEAN DEFAULT false,
          fund_allocations JSON DEFAULT '[]',
          expense_account_ids JSON DEFAULT '[]',
          excluded_tags JSON DEFAULT '[]',
          lookback_months INTEGER DEFAULT 6,
          calculation_method VARCHAR DEFAULT 'mean',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Migration: add new columns if they don't exist
      try {
        await sdk.execute(`ALTER TABLE sys_plugin_emergency_fund_config ADD COLUMN fund_allocations JSON DEFAULT '[]'`);
      } catch (e) { /* column may already exist */ }
      try {
        await sdk.execute(`ALTER TABLE sys_plugin_emergency_fund_config ADD COLUMN target_months_override BOOLEAN DEFAULT false`);
      } catch (e) { /* column may already exist */ }

      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_emergency_fund_snapshots (
          snapshot_id VARCHAR PRIMARY KEY DEFAULT (uuid()),
          snapshot_date DATE NOT NULL,
          fund_balance DECIMAL(15,2) NOT NULL,
          monthly_expenses DECIMAL(15,2) NOT NULL,
          months_of_runway DECIMAL(4,1) NOT NULL,
          notes VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(snapshot_date)
        )
      `);
    } catch (e) {
      // Tables might already exist
    }
  }

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

  async function loadGoals() {
    try {
      const rows = await sdk.query<any>(`
        SELECT id, name, target_amount, allocations, icon, active
        FROM sys_plugin_goals
        WHERE active = true
        ORDER BY name
      `);
      goals = rows.map((r: any) => ({
        id: r[0],
        name: r[1],
        target_amount: r[2],
        allocations: r[3],
        icon: r[4],
        active: r[5],
      }));
    } catch (e) {
      // Goals plugin may not be installed
      goals = [];
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
        FROM sys_plugin_emergency_fund_config
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
        formLinkedGoalId = config.linked_goal_id;
        formTargetMonths = config.target_months ?? 6;
        formTargetMonthsOverride = r[3] ?? false;
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

  async function loadSnapshots() {
    try {
      const rows = await sdk.query<any>(`
        SELECT snapshot_id, snapshot_date, fund_balance, monthly_expenses,
               months_of_runway, notes, created_at
        FROM sys_plugin_emergency_fund_snapshots
        ORDER BY snapshot_date DESC
        LIMIT 12
      `);
      snapshots = rows.map((r: any) => ({
        snapshot_id: r[0],
        snapshot_date: r[1],
        fund_balance: r[2],
        monthly_expenses: r[3],
        months_of_runway: r[4],
        notes: r[5],
        created_at: r[6],
      }));
    } catch (e) {
      snapshots = [];
    }
  }

  async function loadData() {
    await loadAccounts();
    await loadGoals();
    await loadConfig();
    await loadSnapshots();
    if (config) {
      await calculateRunway();
    }
  }

  // Helper function to calculate fund balance from allocations
  async function calculateFundBalanceFromAllocations(allocations: FundAllocation[]): Promise<number> {
    if (allocations.length === 0) return 0;

    const accountIds = allocations.map(a => a.account_id);
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
      WHERE a.account_id IN (${accountIds.map(id => `'${id}'`).join(",")})
    `);

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
      // Get fund balance
      let fundBalance = 0;
      let allocationsToUse: FundAllocation[] = [];

      if (config.linked_goal_id) {
        // Get allocations from linked goal
        const goal = goals.find((g) => g.id === config.linked_goal_id);
        if (goal && goal.allocations) {
          const goalAllocations = typeof goal.allocations === 'string'
            ? JSON.parse(goal.allocations)
            : goal.allocations;
          allocationsToUse = goalAllocations;
        }
      } else {
        // Manual mode - use fund_allocations from config
        allocationsToUse = config.fund_allocations || [];
      }

      fundBalance = await calculateFundBalanceFromAllocations(allocationsToUse);

      // Get monthly expenses
      let monthlyExpenses = 0;

      if (config.expense_account_ids.length > 0) {
        const accountFilter = config.expense_account_ids.map((id) => `'${id}'`).join(",");

        let tagFilter = "";
        if (config.excluded_tags.length > 0) {
          const tagConditions = config.excluded_tags
            .map((tag) => `list_contains(tags, '${tag.replace(/'/g, "''")}')`)
            .join(" OR ");
          tagFilter = `AND NOT (${tagConditions})`;
        }

        const expenseQuery = `
          WITH monthly_totals AS (
            SELECT
              DATE_TRUNC('month', transaction_date) AS month,
              SUM(ABS(amount)) AS total
            FROM transactions
            WHERE amount < 0
              AND account_id IN (${accountFilter})
              ${tagFilter}
              AND transaction_date >= CURRENT_DATE - INTERVAL '${config.lookback_months}' MONTH
            GROUP BY month
          )
          SELECT ${config.calculation_method === "median"
            ? "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total)"
            : config.calculation_method === "trimmed_mean"
            ? "AVG(total) FILTER (WHERE total BETWEEN (SELECT PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY total) FROM monthly_totals) AND (SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total) FROM monthly_totals))"
            : "AVG(total)"
          } AS monthly_avg
          FROM monthly_totals
        `;

        const expenseRows = await sdk.query<any>(expenseQuery);
        monthlyExpenses = expenseRows[0]?.[0] || 0;
      }

      // Calculate runway
      const monthsOfRunway = monthlyExpenses > 0 ? fundBalance / monthlyExpenses : 0;

      // Get target - ALWAYS in months
      let targetMonths = config.target_months ?? 6;

      // If linked to goal and not manually overridden, calculate months from goal's dollar target
      if (config.linked_goal_id) {
        const goal = goals.find((g) => g.id === config.linked_goal_id);
        if (goal && monthlyExpenses > 0) {
          // Auto-calculate months from goal's dollar target
          autoTargetMonths = goal.target_amount / monthlyExpenses;
          // Use auto-calculated unless overridden
          if (!formTargetMonthsOverride && config.target_months === null) {
            targetMonths = autoTargetMonths;
          }
        }
      } else {
        autoTargetMonths = null;
      }

      // Target amount is derived from months
      let targetAmount = monthlyExpenses * targetMonths;

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

      // Show toast if below 80%
      if (status !== "on-track") {
        sdk.toast.warning(
          "Runway alert",
          `${monthsOfRunway.toFixed(1)} months is below your ${targetMonths.toFixed(0)}-month target`
        );
      }

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
      const accountFilter = config.expense_account_ids.map((id) => `'${id}'`).join(",");

      let tagFilter = "";
      if (config.excluded_tags.length > 0) {
        const tagConditions = config.excluded_tags
          .map((tag) => `list_contains(tags, '${tag.replace(/'/g, "''")}')`)
          .join(" OR ");
        tagFilter = `AND NOT (${tagConditions})`;
      }

      const rows = await sdk.query<any>(`
        WITH tagged_expenses AS (
          SELECT
            COALESCE(UNNEST(tags), 'Untagged') AS tag,
            ABS(amount) AS amount
          FROM transactions
          WHERE amount < 0
            AND account_id IN (${accountFilter})
            ${tagFilter}
            AND transaction_date >= CURRENT_DATE - INTERVAL '${config.lookback_months}' MONTH
        ),
        totals AS (
          SELECT SUM(amount) as grand_total FROM tagged_expenses
        )
        SELECT
          tag,
          ROUND(SUM(amount) / ${config.lookback_months}, 2) AS monthly_avg,
          ROUND(SUM(amount) / (SELECT grand_total FROM totals) * 100, 1) AS pct
        FROM tagged_expenses
        GROUP BY tag
        ORDER BY monthly_avg DESC
      `);

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
      const escapedTags = JSON.stringify(formExcludedTags);
      const escapedExpenseAccounts = JSON.stringify(formExpenseAccountIds);
      const escapedAllocations = JSON.stringify(formFundAllocations);

      // When linked to goal, target_months can be null (auto-calc) unless overridden
      const targetMonthsValue = formLinkedGoalId && !formTargetMonthsOverride
        ? "NULL"
        : formTargetMonths;

      if (config) {
        await sdk.execute(`
          UPDATE sys_plugin_emergency_fund_config
          SET linked_goal_id = ${formLinkedGoalId ? `'${formLinkedGoalId}'` : "NULL"},
              target_months = ${targetMonthsValue},
              target_months_override = ${formTargetMonthsOverride},
              fund_allocations = '${escapedAllocations}',
              expense_account_ids = '${escapedExpenseAccounts}',
              excluded_tags = '${escapedTags}',
              lookback_months = ${formLookbackMonths},
              calculation_method = '${formCalculationMethod}',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = '${config.id}'
        `);
      } else {
        await sdk.execute(`
          INSERT INTO sys_plugin_emergency_fund_config
            (linked_goal_id, target_months, target_months_override, fund_allocations,
             expense_account_ids, excluded_tags, lookback_months, calculation_method)
          VALUES (
            ${formLinkedGoalId ? `'${formLinkedGoalId}'` : "NULL"},
            ${targetMonthsValue},
            ${formTargetMonthsOverride},
            '${escapedAllocations}',
            '${escapedExpenseAccounts}',
            '${escapedTags}',
            ${formLookbackMonths},
            '${formCalculationMethod}'
          )
        `);
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

  // Snapshot management
  async function addSnapshot() {
    if (!runwayData) return;

    try {
      const today = new Date().toISOString().split("T")[0];
      await sdk.execute(`
        INSERT INTO sys_plugin_emergency_fund_snapshots
          (snapshot_date, fund_balance, monthly_expenses, months_of_runway)
        VALUES (
          '${today}',
          ${runwayData.fundBalance},
          ${runwayData.monthlyExpenses},
          ${runwayData.monthsOfRunway}
        )
        ON CONFLICT (snapshot_date) DO UPDATE SET
          fund_balance = ${runwayData.fundBalance},
          monthly_expenses = ${runwayData.monthlyExpenses},
          months_of_runway = ${runwayData.monthsOfRunway}
      `);
      await loadSnapshots();
      sdk.toast.success("Snapshot added");
    } catch (e) {
      sdk.toast.error("Failed to add snapshot", e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteSnapshot(snapshotId: string) {
    try {
      await sdk.execute(`
        DELETE FROM sys_plugin_emergency_fund_snapshots
        WHERE snapshot_id = '${snapshotId}'
      `);
      await loadSnapshots();
      sdk.toast.info("Snapshot deleted");
    } catch (e) {
      sdk.toast.error("Failed to delete snapshot", e instanceof Error ? e.message : String(e));
    }
  }

  // Dev: Reset plugin data
  async function resetPluginData() {
    if (!confirm("This will delete all Emergency Fund config and snapshots. Continue?")) {
      return;
    }

    try {
      await sdk.execute(`DELETE FROM sys_plugin_emergency_fund_config`);
      await sdk.execute(`DELETE FROM sys_plugin_emergency_fund_snapshots`);

      // Reset state
      config = null;
      snapshots = [];
      runwayData = null;
      autoTargetMonths = null;
      formLinkedGoalId = null;
      formTargetMonths = 6;
      formTargetMonthsOverride = false;
      formFundAllocations = [];
      formExpenseAccountIds = [];
      formExcludedTags = [];
      formLookbackMonths = 6;
      formCalculationMethod = "mean";

      showSetup = true;
      sdk.toast.success("Plugin data reset");
    } catch (e) {
      sdk.toast.error("Failed to reset", e instanceof Error ? e.message : String(e));
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
    const escapedTags = JSON.stringify(newExcludedTags);

    try {
      await sdk.execute(`
        UPDATE sys_plugin_emergency_fund_config
        SET excluded_tags = '${escapedTags}',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${config.id}'
      `);

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
      case "a":
        e.preventDefault();
        addSnapshot();
        break;
      case "j":
      case "ArrowDown":
        e.preventDefault();
        selectedSnapshotIndex = Math.min(selectedSnapshotIndex + 1, snapshots.length - 1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        selectedSnapshotIndex = Math.max(selectedSnapshotIndex - 1, -1);
        break;
      case "d":
        if (selectedSnapshotIndex >= 0 && snapshots[selectedSnapshotIndex]) {
          e.preventDefault();
          deleteSnapshot(snapshots[selectedSnapshotIndex].snapshot_id);
        }
        break;
      case "Escape":
        selectedSnapshotIndex = -1;
        break;
    }
  }

  // Derived
  let linkedGoal = $derived(goals.find((g) => g.id === config?.linked_goal_id));
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
  let runwayChange = $derived.by(() => {
    if (!runwayData || snapshots.length === 0) return null;
    const lastSnapshot = snapshots[0]; // snapshots are ordered by date DESC
    return runwayData.monthsOfRunway - lastSnapshot.months_of_runway;
  });
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
    <!-- Setup Screen -->
    <div class="setup-screen">
      <div class="setup-content">
        <div class="setup-icon">🛡️</div>
        <h2>Set Up Emergency Fund</h2>
        <p class="setup-desc">Track how many months of expenses your safety net covers</p>

        {#if goals.length > 0}
          <div class="setup-section">
            <h3>Link to Savings Goal?</h3>
            <p class="setup-hint">If you have a savings goal for your emergency fund, we can use its accounts and auto-calculate the target months.</p>
            <div class="goal-options">
              {#each goals as goal}
                <button
                  class="goal-option"
                  class:selected={formLinkedGoalId === goal.id}
                  onclick={() => {
                    formLinkedGoalId = goal.id;
                    formTargetMonthsOverride = false;
                  }}
                >
                  <span class="goal-icon">{goal.icon || "🎯"}</span>
                  <span class="goal-name">{goal.name}</span>
                  <span class="goal-target">{formatCurrency(goal.target_amount)}</span>
                </button>
              {/each}
              <button
                class="goal-option manual"
                class:selected={formLinkedGoalId === null}
                onclick={() => {
                  formLinkedGoalId = null;
                  formTargetMonthsOverride = false;
                }}
              >
                <span class="goal-icon">⚙️</span>
                <span class="goal-name">Set up manually</span>
              </button>
            </div>
          </div>
        {/if}

        {#if formLinkedGoalId === null}
          <div class="setup-section">
            <h3>Target Months</h3>
            <select bind:value={formTargetMonths} class="select-input">
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={9}>9 months</option>
              <option value={12}>12 months</option>
            </select>
          </div>

          <div class="setup-section">
            <h3>Emergency Fund Accounts</h3>
            <p class="setup-hint">Which accounts hold your emergency fund? You can allocate a percentage or fixed amount from each.</p>

            <!-- Account selector -->
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

            <!-- Allocation details for selected accounts -->
            {#if formFundAllocations.length > 0}
              <div class="allocation-details">
                <h4>Allocation Details</h4>
                {#each formFundAllocations as alloc}
                  <div class="allocation-row">
                    <span class="alloc-account">{getAccountName(alloc.account_id)}</span>
                    <select
                      class="select-input small"
                      value={alloc.allocation_type}
                      onchange={(e) => updateAllocation(alloc.account_id, 'allocation_type', e.currentTarget.value)}
                    >
                      <option value="percentage">% of balance</option>
                      <option value="fixed">Fixed amount</option>
                    </select>
                    <div class="alloc-value-input">
                      {#if alloc.allocation_type === 'percentage'}
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={alloc.allocation_value}
                          onchange={(e) => updateAllocation(alloc.account_id, 'allocation_value', Number(e.currentTarget.value))}
                        />
                        <span class="alloc-suffix">%</span>
                      {:else}
                        <span class="alloc-prefix">$</span>
                        <input
                          type="number"
                          min="0"
                          value={alloc.allocation_value}
                          onchange={(e) => updateAllocation(alloc.account_id, 'allocation_value', Number(e.currentTarget.value))}
                        />
                      {/if}
                    </div>
                    <button class="remove-alloc-btn" onclick={() => removeFundAllocation(alloc.account_id)}>×</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <div class="setup-section required">
          <h3>Expense Accounts <span class="required-badge">Required</span></h3>
          <p class="setup-hint">Which accounts do you spend from? This is used to calculate your monthly expenses.</p>
          <div class="account-list">
            {#each accounts as account}
              <label class="account-option">
                <input
                  type="checkbox"
                  checked={formExpenseAccountIds.includes(account.account_id)}
                  onchange={() => toggleExpenseAccount(account.account_id)}
                />
                <span class="account-name">{account.account_name}</span>
                <span class="account-type">{account.account_type}</span>
              </label>
            {/each}
          </div>
          {#if formExpenseAccountIds.length === 0}
            <p class="warning-text">Please select at least one account</p>
          {/if}
        </div>

        <div class="setup-section">
          <h3>Exclude Tags (Optional)</h3>
          <p class="setup-hint">Exclude transactions with these tags from expense calculation</p>
          <div class="tag-input-row">
            <select
              class="select-input"
              bind:value={newTagInput}
              onchange={() => { if (newTagInput) addExcludedTag(newTagInput); }}
            >
              <option value="">Select a tag...</option>
              {#each availableTags.filter(t => !formExcludedTags.includes(t)) as tag}
                <option value={tag}>{tag}</option>
              {/each}
            </select>
          </div>
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

        <div class="setup-actions">
          <button
            class="btn primary"
            onclick={saveConfig}
            disabled={formExpenseAccountIds.length === 0}
          >
            Save & Continue
          </button>
        </div>
      </div>
    </div>
  {:else if runwayData}
    <!-- Main View -->
    <header class="header">
      <div class="title-row">
        <h1 class="title">Emergency Fund</h1>
        {#if linkedGoal}
          <span class="linked-badge">
            {linkedGoal.icon || "🎯"} {linkedGoal.name}
          </span>
        {/if}
        <div class="header-spacer"></div>
        <button class="icon-btn" onclick={() => showSettings = true} title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="refresh-btn" onclick={() => loadData()}>Refresh</button>
      </div>

      <!-- Hero Cards -->
      <div class="hero-cards">
        <div class="hero-card runway" style="--status-color: {statusColor}">
          <span class="hero-label">Your Runway</span>
          <span class="hero-value">
            <span class="status-icon">{statusIcon}</span>
            {runwayData.monthsOfRunway.toFixed(1)} months
          </span>
          {#if runwayChange !== null && Math.abs(runwayChange) >= 0.05}
            <span class="hero-sub change-indicator" class:positive={runwayChange > 0} class:negative={runwayChange < 0}>
              {runwayChange > 0 ? '▲' : '▼'}
              {Math.abs(runwayChange).toFixed(1)} mo from last
            </span>
          {/if}
        </div>
        <div class="hero-card">
          <span class="hero-label">Current Fund</span>
          <span class="hero-value">{formatCurrency(runwayData.fundBalance)}</span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Target</span>
          <span class="hero-value">{runwayData.targetMonths.toFixed(1)} months</span>
          <span class="hero-sub">
            ≈{formatCurrency(runwayData.targetAmount)}
            {#if linkedGoal && !formTargetMonthsOverride}
              (from goal)
            {/if}
          </span>
        </div>
        <button class="sql-link" onclick={viewSQL}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          View SQL
        </button>
      </div>

      <!-- Progress Bar -->
      <div class="progress-section">
        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: {Math.min(runwayData.progressPercent, 100)}%; background: {statusColor}"
          ></div>
        </div>
        <div class="progress-label">
          {runwayData.progressPercent.toFixed(0)}% of target
          {#if runwayData.remainingToTarget > 0}
            <span class="remaining">({formatCurrency(runwayData.remainingToTarget)} to go)</span>
          {/if}
        </div>
      </div>
    </header>

    <div class="main-content">
      <div class="content-grid">
        <!-- Expense Breakdown -->
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Monthly Expenses</h2>
            <span class="section-value">{formatCurrency(runwayData.monthlyExpenses)}</span>
          </div>
          <p class="section-hint">
            {config?.lookback_months}-month {config?.calculation_method === "median" ? "median" : "average"}
            {#if config?.excluded_tags && config.excluded_tags.length > 0}
              • Excludes: {config.excluded_tags.join(", ")}
            {/if}
          </p>

          {#if expenseBreakdown.length > 0}
            <div class="breakdown-list">
              {#each expenseBreakdown as item}
                <div class="breakdown-row">
                  <span class="breakdown-tag">{item.tag}</span>
                  <span class="breakdown-amount">{formatCurrency(item.amount)}</span>
                  <span class="breakdown-percent">{item.percent}%</span>
                  <span class="breakdown-runway">
                    {(runwayData.fundBalance / item.amount).toFixed(1)} mo
                  </span>
                  {#if item.tag !== 'Untagged'}
                    <button
                      class="exclude-btn"
                      onclick={() => quickExcludeTag(item.tag)}
                      title="Exclude from expenses"
                    >×</button>
                  {:else}
                    <span class="exclude-placeholder"></span>
                  {/if}
                </div>
              {/each}
            </div>
            <details class="breakdown-help">
              <summary>Why don't these add up to 100%?</summary>
              <p>Transactions with multiple tags are counted in each tag. For example, a $100 purchase tagged "groceries" and "costco" appears as $100 in both.</p>
            </details>
          {:else}
            <p class="empty-hint">No expense data available</p>
          {/if}
        </section>

        <!-- Runway History -->
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Runway History</h2>
            <button class="add-btn" onclick={addSnapshot}>+ Add Snapshot</button>
          </div>

          {#if snapshots.length > 0}
            <div class="snapshot-list">
              {#each snapshots as snapshot, i}
                <div
                  class="snapshot-row"
                  class:selected={i === selectedSnapshotIndex}
                  onclick={() => selectedSnapshotIndex = i}
                  role="button"
                  tabindex="0"
                >
                  <span class="snapshot-date">{formatDate(snapshot.snapshot_date)}</span>
                  <span class="snapshot-runway">{snapshot.months_of_runway.toFixed(1)} mo</span>
                  <span class="snapshot-balance">{formatCurrency(snapshot.fund_balance)}</span>
                  <button
                    class="delete-btn"
                    onclick={(e) => { e.stopPropagation(); deleteSnapshot(snapshot.snapshot_id); }}
                    title="Delete snapshot"
                  >×</button>
                </div>
              {/each}
            </div>
          {:else}
            <p class="empty-hint">No snapshots yet. Add one to track progress over time.</p>
          {/if}
        </section>
      </div>
    </div>

    <!-- Keyboard Hints -->
    <footer class="keyboard-hints">
      <span class="hint"><kbd>s</kbd> settings</span>
      <span class="hint"><kbd>r</kbd> refresh</span>
      <span class="hint"><kbd>v</kbd> view SQL</span>
      <span class="hint"><kbd>a</kbd> add snapshot</span>
      <span class="hint"><kbd>j/k</kbd> navigate</span>
      <span class="hint"><kbd>d</kbd> delete</span>
      <div class="dev-spacer"></div>
      <button class="btn danger" onclick={resetPluginData}>Reset Plugin Data</button>
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
        <h3>Emergency Fund Settings</h3>
        <button class="close-btn" onclick={() => showSettings = false}>×</button>
      </div>

      <div class="modal-body">
        <!-- Goal Integration -->
        {#if goals.length > 0}
          <div class="settings-section">
            <h4>Goal Integration</h4>
            <select
              class="select-input"
              value={formLinkedGoalId}
              onchange={(e) => {
                formLinkedGoalId = e.currentTarget.value === "" ? null : e.currentTarget.value;
                if (formLinkedGoalId) {
                  formTargetMonthsOverride = false;
                }
              }}
            >
              <option value="">Manual setup</option>
              {#each goals as goal}
                <option value={goal.id}>{goal.icon || "🎯"} {goal.name} ({formatCurrency(goal.target_amount)})</option>
              {/each}
            </select>
            <p class="setting-hint">When linked, fund accounts and target months are auto-calculated from your goal.</p>
          </div>
        {/if}

        <!-- Target Months Section -->
        <div class="settings-section">
          <h4>Target Months</h4>
          {#if formLinkedGoalId && autoTargetMonths}
            <div class="auto-target-info">
              <span class="auto-label">Auto-calculated: {autoTargetMonths.toFixed(1)} months</span>
              <span class="auto-hint">(from {formatCurrency(linkedGoal?.target_amount ?? 0)} goal ÷ monthly expenses)</span>
            </div>
            <label class="override-option">
              <input type="checkbox" bind:checked={formTargetMonthsOverride} />
              <span>Override with custom target</span>
            </label>
          {/if}
          {#if !formLinkedGoalId || formTargetMonthsOverride}
            <select bind:value={formTargetMonths} class="select-input">
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={9}>9 months</option>
              <option value={12}>12 months</option>
            </select>
          {/if}
        </div>

        {#if formLinkedGoalId === null}
          <div class="settings-section">
            <h4>Emergency Fund Accounts</h4>
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

            <!-- Allocation details -->
            {#if formFundAllocations.length > 0}
              <div class="allocation-details compact">
                {#each formFundAllocations as alloc}
                  <div class="allocation-row">
                    <span class="alloc-account">{getAccountName(alloc.account_id)}</span>
                    <select
                      class="select-input small"
                      value={alloc.allocation_type}
                      onchange={(e) => updateAllocation(alloc.account_id, 'allocation_type', e.currentTarget.value)}
                    >
                      <option value="percentage">%</option>
                      <option value="fixed">$</option>
                    </select>
                    <input
                      type="number"
                      class="alloc-input"
                      min="0"
                      max={alloc.allocation_type === 'percentage' ? 100 : undefined}
                      value={alloc.allocation_value}
                      onchange={(e) => updateAllocation(alloc.account_id, 'allocation_value', Number(e.currentTarget.value))}
                    />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

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

        <div class="settings-section">
          <h4>Exclude Tags</h4>
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

        <div class="settings-section">
          <h4>Calculation Settings</h4>
          <div class="setting-row">
            <label>Lookback:</label>
            <select bind:value={formLookbackMonths} class="select-input small">
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </div>
          <div class="setting-row">
            <label>Method:</label>
            <select bind:value={formCalculationMethod} class="select-input small">
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

  /* Setup Screen */
  .setup-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .setup-content {
    max-width: 500px;
    width: 100%;
  }

  .setup-icon {
    font-size: 48px;
    text-align: center;
    margin-bottom: 16px;
  }

  .setup-content h2 {
    font-size: 24px;
    font-weight: 600;
    text-align: center;
    margin: 0 0 8px 0;
  }

  .setup-desc {
    text-align: center;
    color: var(--text-muted);
    margin: 0 0 24px 0;
  }

  .setup-section {
    margin-bottom: 24px;
  }

  .setup-section h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  .setup-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 12px 0;
  }

  .goal-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .goal-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: var(--bg-secondary);
    border: 2px solid var(--border-primary);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .goal-option:hover {
    border-color: var(--accent-primary);
  }

  .goal-option.selected {
    border-color: var(--accent-primary);
    background: rgba(88, 166, 255, 0.1);
  }

  .goal-icon {
    font-size: 20px;
  }

  .goal-name {
    flex: 1;
    font-weight: 500;
  }

  .goal-target {
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }

  .account-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 200px;
    overflow-y: auto;
  }

  .account-list.compact {
    max-height: 150px;
  }

  .account-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-radius: 6px;
    cursor: pointer;
  }

  .account-option:hover {
    background: var(--bg-tertiary);
  }

  .account-name {
    flex: 1;
  }

  .account-balance, .account-type {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Allocation Details */
  .allocation-details {
    margin-top: 16px;
    padding: 12px;
    background: var(--bg-tertiary);
    border-radius: 6px;
  }

  .allocation-details h4 {
    font-size: 12px;
    font-weight: 600;
    margin: 0 0 12px 0;
    color: var(--text-secondary);
  }

  .allocation-details.compact {
    margin-top: 12px;
    padding: 8px;
  }

  .allocation-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .allocation-row:last-child {
    margin-bottom: 0;
  }

  .alloc-account {
    flex: 1;
    font-size: 13px;
    min-width: 100px;
  }

  .alloc-value-input {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .alloc-value-input input,
  .alloc-input {
    width: 70px;
    padding: 6px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono);
  }

  .alloc-value-input input:focus,
  .alloc-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .alloc-prefix, .alloc-suffix {
    font-size: 12px;
    color: var(--text-muted);
  }

  .remove-alloc-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 16px;
    border-radius: 4px;
  }

  .remove-alloc-btn:hover {
    color: var(--accent-danger);
    background: rgba(220, 38, 38, 0.1);
  }

  /* Auto target info */
  .auto-target-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    margin-bottom: 8px;
  }

  .auto-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--accent-primary);
  }

  .auto-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .override-option {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    margin-bottom: 8px;
  }

  .tag-input-row {
    display: flex;
    gap: 8px;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--accent-primary);
    color: white;
    border-radius: 4px;
    font-size: 12px;
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

  .setup-actions {
    display: flex;
    justify-content: center;
    margin-top: 24px;
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

  /* Header */
  .header {
    padding: 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  .linked-badge {
    font-size: 12px;
    padding: 4px 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .header-spacer {
    flex: 1;
  }

  .icon-btn {
    background: none;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
  }

  .icon-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .refresh-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .refresh-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Hero Cards */
  .hero-cards {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  .hero-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .hero-card.runway {
    border-left: 4px solid var(--status-color);
  }

  .hero-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .hero-value {
    font-size: 20px;
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .hero-sub {
    font-size: 11px;
    color: var(--text-muted);
  }

  .change-indicator {
    font-family: var(--font-mono);
  }

  .change-indicator.positive {
    color: var(--accent-success);
  }

  .change-indicator.negative {
    color: var(--accent-danger);
  }

  .status-icon {
    margin-right: 4px;
  }

  .sql-link {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .sql-link:hover {
    background: var(--bg-tertiary);
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  /* Progress */
  .progress-section {
    margin-top: 16px;
  }

  .progress-bar {
    height: 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-label {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 8px;
  }

  .remaining {
    color: var(--text-muted);
  }

  /* Main Content */
  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .content-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  @media (max-width: 800px) {
    .content-grid {
      grid-template-columns: 1fr;
    }
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

  .section-value {
    font-size: 18px;
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .section-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin: 0 0 16px 0;
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    padding: 24px;
  }

  /* Breakdown */
  .breakdown-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 400px;
    overflow-y: auto;
  }

  .breakdown-row {
    display: grid;
    grid-template-columns: 1fr auto auto auto auto;
    gap: 12px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-primary);
  }

  .breakdown-row:last-child {
    border-bottom: none;
  }

  .exclude-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.15s;
    border-radius: 3px;
  }

  .breakdown-row:hover .exclude-btn {
    opacity: 1;
  }

  .exclude-btn:hover {
    color: var(--accent-danger);
    background: rgba(220, 38, 38, 0.1);
  }

  .exclude-placeholder {
    width: 24px;
  }

  .breakdown-help {
    margin-top: 12px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .breakdown-help summary {
    cursor: pointer;
    color: var(--text-secondary);
  }

  .breakdown-help summary:hover {
    color: var(--accent-primary);
  }

  .breakdown-help p {
    margin: 8px 0 0 0;
    padding: 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    line-height: 1.4;
  }

  .breakdown-tag {
    font-size: 13px;
  }

  .breakdown-amount {
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .breakdown-percent {
    font-size: 11px;
    color: var(--text-muted);
    width: 40px;
    text-align: right;
  }

  .breakdown-runway {
    font-size: 11px;
    color: var(--text-muted);
    width: 50px;
    text-align: right;
  }

  /* Snapshots */
  .add-btn {
    padding: 4px 8px;
    background: var(--accent-primary);
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 11px;
    cursor: pointer;
  }

  .add-btn:hover {
    opacity: 0.9;
  }

  .snapshot-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .snapshot-row {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 12px;
    align-items: center;
    padding: 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .snapshot-row:hover {
    background: var(--bg-tertiary);
  }

  .snapshot-row.selected {
    background: rgba(88, 166, 255, 0.1);
  }

  .snapshot-date {
    font-size: 13px;
  }

  .snapshot-runway {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 500;
  }

  .snapshot-balance {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  .delete-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 16px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .snapshot-row:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: var(--accent-danger);
  }

  /* Keyboard Hints */
  .keyboard-hints {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 16px;
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

  .dev-spacer {
    flex: 1;
  }
</style>
