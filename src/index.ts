import type { Plugin, PluginContext, PluginSDK, PluginMigration } from "@treeline-money/plugin-sdk";
import EmergencyFundView from "./EmergencyFundView.svelte";
import { mount, unmount } from "svelte";

// Database migrations - run in order by version when plugin loads
const migrations: PluginMigration[] = [
  {
    version: 1,
    name: "create_initial_tables",
    up: `
      CREATE TABLE IF NOT EXISTS plugin_emergency_fund.config (
        id VARCHAR PRIMARY KEY DEFAULT (uuid()),
        linked_goal_id VARCHAR,
        target_months DECIMAL(4,1),
        expense_account_ids JSON DEFAULT '[]',
        excluded_tags JSON DEFAULT '[]',
        lookback_months INTEGER DEFAULT 6,
        calculation_method VARCHAR DEFAULT 'mean',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plugin_emergency_fund.snapshots (
        snapshot_id VARCHAR PRIMARY KEY DEFAULT (uuid()),
        snapshot_date DATE NOT NULL,
        fund_balance DECIMAL(15,2) NOT NULL,
        monthly_expenses DECIMAL(15,2) NOT NULL,
        months_of_runway DECIMAL(4,1) NOT NULL,
        notes VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(snapshot_date)
      )
    `,
  },
  {
    version: 2,
    name: "add_fund_allocations_column",
    up: `ALTER TABLE plugin_emergency_fund.config ADD COLUMN IF NOT EXISTS fund_allocations JSON DEFAULT '[]'`,
  },
  {
    version: 3,
    name: "add_target_months_override_column",
    up: `ALTER TABLE plugin_emergency_fund.config ADD COLUMN IF NOT EXISTS target_months_override BOOLEAN DEFAULT false`,
  },
];

export const plugin: Plugin = {
  manifest: {
    id: "emergency-fund",
    name: "Emergency Fund",
    version: "0.1.8",
    description: "Track emergency fund runway based on your actual expenses",
    author: "Treeline",
    permissions: {
      read: ["transactions", "accounts", "sys_balance_snapshots"],
      schemaName: "plugin_emergency_fund",
    },
  },

  migrations,

  activate(context: PluginContext) {
    // Register the emergency fund view
    context.registerView({
      id: "emergency-fund",
      name: "Emergency Fund",
      icon: "shield",
      mount: (target: HTMLElement, props: { sdk: PluginSDK }) => {
        const instance = mount(EmergencyFundView, {
          target,
          props,
        });

        return () => {
          unmount(instance);
        };
      },
    });

    // Add sidebar item
    context.registerSidebarItem({
      sectionId: "main",
      id: "emergency-fund",
      label: "Emergency Fund",
      icon: "shield",
      viewId: "emergency-fund",
    });

    // Register command for quick access
    context.registerCommand({
      id: "emergency-fund.open",
      name: "View Emergency Fund",
      description: "Open the emergency fund tracker",
      execute: () => {
        context.openView("emergency-fund");
      },
    });

    console.log("✓ Emergency Fund plugin loaded");
  },

  deactivate() {
    console.log("Emergency Fund plugin deactivated");
  },
};
