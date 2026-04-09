import { Outlet, createRootRoute } from "@tanstack/react-router";

function RootLayout() {
  return <Outlet />;
}

export const Route = createRootRoute({
  component: RootLayout,
});
