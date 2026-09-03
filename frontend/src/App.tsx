import { Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { TrackerAuth } from "./pages/TrackerAuth";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("token");
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Three segments, so /:section cannot swallow it. No RequireAuth: the page sends an
          unauthenticated visitor through /login itself and comes back. */}
      <Route path="/tracker-auth/:port/:state" element={<TrackerAuth />} />
      {/* Розділ у URL (/report, /kvp, …) — щоб працювали посилання, «назад/вперед»,
          закладки. «/» = Звіт (лендинг). Обидва шляхи рендерять один Dashboard. */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/:section"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default App;
