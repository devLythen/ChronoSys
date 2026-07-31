import { lazy, Suspense } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { createHashRouter, Navigate } from "react-router-dom";
import Shell from "./components/Shell";

function RouteFallback() {
  return (
    <div className="animate-fade-in py-24 text-center" aria-live="polite">
      <p className="t-body text-muted-fg">Loading view…</p>
    </div>
  );
}

function Page({ Component }: { Component: LazyExoticComponent<ComponentType> }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Component />
    </Suspense>
  );
}

const Overview = lazy(() => import("./pages/Overview"));
const ProviderEditor = lazy(() => import("./pages/ProviderEditor"));
const ProvidersPage = lazy(() => import("./pages/ProvidersPage"));
const ConfigList = lazy(() => import("./pages/ConfigList"));
const ConfigEditor = lazy(() => import("./pages/ConfigEditor"));
const PersonaList = lazy(() => import("./pages/PersonaList"));
const PersonaEditor = lazy(() => import("./pages/PersonaEditor"));
const PlatformsPage = lazy(() => import("./pages/PlatformsPage"));
const AccountEditor = lazy(() => import("./pages/AccountEditor"));
const SessionsList = lazy(() => import("./pages/SessionsList"));
const SessionDetail = lazy(() => import("./pages/SessionDetail"));
const AuditPage = lazy(() => import("./pages/AuditPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const PluginsExtensions = lazy(() => import("./pages/PluginsExtensions"));
const PluginEditor = lazy(() => import("./pages/PluginEditor"));
const PluginsMcp = lazy(() => import("./pages/PluginsMcp"));
const PluginsSkills = lazy(() => import("./pages/PluginsSkills"));
export const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: "overview", element: <Page Component={Overview} /> },
      { path: "platforms", element: <Page Component={PlatformsPage} /> },
      { path: "platforms/:id", element: <Page Component={AccountEditor} /> },
      { path: "config", element: <Page Component={ConfigList} /> },
      { path: "config/:id", element: <Page Component={ConfigEditor} /> },
      { path: "providers", element: <Page Component={ProvidersPage} /> },
      { path: "providers/:id", element: <Page Component={ProviderEditor} /> },
      { path: "persona", element: <Page Component={PersonaList} /> },
      { path: "persona/:id", element: <Page Component={PersonaEditor} /> },
      { path: "sessions", element: <Page Component={SessionsList} /> },
      { path: "sessions/:id", element: <Page Component={SessionDetail} /> },
      { path: "audit", element: <Page Component={AuditPage} /> },
      { path: "settings", element: <Page Component={SettingsPage} /> },
      { path: "plugins/extensions", element: <Page Component={PluginsExtensions} /> },
      { path: "plugins/extensions/:id", element: <Page Component={PluginEditor} /> },
      { path: "plugins/mcp", element: <Page Component={PluginsMcp} /> },
      { path: "plugins/skills", element: <Page Component={PluginsSkills} /> },
    ],
  },
]);
