import { createHashRouter, Navigate } from "react-router-dom";
import Shell from "./components/Shell";
import Overview from "./pages/Overview";
import ProvidersPage from "./pages/ProvidersPage";
import ConfigList from "./pages/ConfigList";
import ConfigEditor from "./pages/ConfigEditor";
import PersonaList from "./pages/PersonaList";
import PersonaEditor from "./pages/PersonaEditor";
import PlatformsPage from "./pages/PlatformsPage";
import SessionsList from "./pages/SessionsList";
import SessionDetail from "./pages/SessionDetail";
import AuditPage from "./pages/AuditPage";
import SettingsPage from "./pages/SettingsPage";

export const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: "overview", element: <Overview /> },
      { path: "platforms", element: <PlatformsPage /> },
      { path: "config", element: <ConfigList /> },
      { path: "config/:id", element: <ConfigEditor /> },
      { path: "providers", element: <ProvidersPage /> },
      { path: "persona", element: <PersonaList /> },
      { path: "persona/:id", element: <PersonaEditor /> },
      { path: "sessions", element: <SessionsList /> },
      { path: "sessions/:id", element: <SessionDetail /> },
      { path: "audit", element: <AuditPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
