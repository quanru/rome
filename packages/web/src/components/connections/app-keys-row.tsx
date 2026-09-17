import { useQuery } from "@tanstack/react-query";
import { ChevronRight, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ListRow, ListRowContent, ListRowTitle } from "@/components/ui/list-row";
import { APP_KEYS_QUERY_KEY, fetchAppKeys } from "@/lib/app-keys-api";
import { cn } from "@/lib/utils";

/**
 * The app-keys entry in the Connections list: same row anatomy as a service
 * row (badge + label left, muted status text right), but it navigates to
 * `/settings/connections/app-keys` instead of opening a ceremony dialog — the
 * chevron carries that difference. The right side shows the stored-key count
 * rather than the connection status vocabulary, which is reserved for
 * credentials.
 */

/** Square badge for the app-keys vault. Rome-owned surface treatment — same
 * primary-tinted box as the Email and Composio badges in
 * `ConnectionBrandBadge`. */
export function AppKeysBadge({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-8 bg-primary/15 text-primary",
        className,
      )}
      aria-hidden
    >
      <KeyRound className="h-5 w-5" />
    </div>
  );
}

export function AppKeysRow() {
  const { t } = useTranslation("settings");
  const keysQuery = useQuery({ queryKey: APP_KEYS_QUERY_KEY, queryFn: fetchAppKeys });
  const count = keysQuery.data?.length;

  return (
    <ListRow asChild interactive>
      <Link to="/settings/connections/app-keys" aria-label={t("appKeys.openLabel")}>
        <AppKeysBadge />
        <ListRowContent>
          <ListRowTitle className="truncate">{t("appKeys.title")}</ListRowTitle>
        </ListRowContent>
        <span className="inline-flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
          {count !== undefined &&
            (count === 0 ? t("appKeys.noKeysYet") : t("appKeys.keyCount", { count }))}
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </Link>
    </ListRow>
  );
}
