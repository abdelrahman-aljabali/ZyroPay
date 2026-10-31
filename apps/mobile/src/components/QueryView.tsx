import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorState, ListSkeleton } from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";

export interface QueryViewProps<T> {
  readonly query: UseQueryResult<T>;
  readonly children: (data: T) => ReactNode;
  readonly loading?: ReactNode;
  /** Rendered instead of children when `isEmpty(data)` is true. */
  readonly empty?: ReactNode;
  readonly isEmpty?: (data: T) => boolean;
}

/** Uniform loading / error / empty / success rendering for a query. */
export function QueryView<T>({ query, children, loading, empty, isEmpty }: QueryViewProps<T>) {
  if (query.isPending) return <>{loading ?? <ListSkeleton />}</>;
  if (query.isError) {
    return (
      <ErrorState
        title={isApiError(query.error, "NOT_FOUND") ? "Not found" : "Couldn't load"}
        message={errorMessage(query.error)}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (empty !== undefined && isEmpty?.(query.data) === true) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
