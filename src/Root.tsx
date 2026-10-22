import App from "./App";
import AdminApp from "./AdminApp";
import { SharePage } from "./screens/SharePage";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function Root({ pathname }: { pathname: string }) {
  return <ErrorBoundary>{pick(pathname)}</ErrorBoundary>;
}

function pick(pathname: string) {
  if (pathname.startsWith("/admin")) return <AdminApp />;
  if (pathname.startsWith("/share/")) return <SharePage token={pathname.slice("/share/".length)} />;
  return <App />;
}
