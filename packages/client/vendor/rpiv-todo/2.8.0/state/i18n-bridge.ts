/** SDK-owned integration of the upstream localization bridge.
 * The real i18n library is required. The sole private runtime entry loads this
 * graph after preverification and registers the exact release locale files.
 * Keep render-time scope lookup so live applyLocale updates remain visible.
 */

import type { TaskStatus } from "../tool/types.js";

export const I18N_NAMESPACE = "@juicesharp/rpiv-todo";

// SDK integration requires the real library; no optional English-only path.
import { scope } from "@juicesharp/rpiv-i18n";
export const t = scope(I18N_NAMESPACE);

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return t("status.pending", STATUS_LABEL_PENDING);
		case "in_progress":
			return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
		case "completed":
			return t("status.completed", STATUS_LABEL_COMPLETED);
		case "deleted":
			return t("status.deleted", STATUS_LABEL_DELETED);
	}
}
