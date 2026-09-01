import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { trackerAssertion } from "../api";
import { Logo } from "../components/Logo";

/**
 * Confirms to the desktop time tracker who the current dashboard user is.
 *
 * The agent opens this page in the browser, where the person is usually already signed in, and
 * waits on a loopback port. This page turns the existing session into a two-minute assertion and
 * hands it back. Nobody types a password into the agent, which is the whole point: a second
 * password for the same person ends up on paper.
 *
 * The redirect target is built here, not taken from the query: only the port number comes from
 * the agent, and the host is fixed. A URL supplied whole would make this an open redirect that
 * anyone could aim anywhere.
 */
export function TrackerAuth() {
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("port"));
  const state = params.get("state") ?? "";
  const token = localStorage.getItem("token");

  const [error, setError] = useState<string | null>(null);

  // Ports below 1024 need privileges the agent does not have, so a value there means the query
  // was not written by our agent.
  const usable = Number.isInteger(port) && port > 1024 && port < 65536 && state.length > 0;

  useEffect(() => {
    if (!usable || !token) return;
    let cancelled = false;

    (async () => {
      try {
        const { assertion } = await trackerAssertion();
        if (cancelled) return;
        const back = new URL(`http://127.0.0.1:${port}/callback`);
        back.searchParams.set("state", state);
        back.searchParams.set("assertion", assertion);
        window.location.replace(back.toString());
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Не вдалося підтвердити вхід.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [usable, token, port, state]);

  if (!usable) {
    return (
      <Frame>
        <p>Посилання неповне або застаріле.</p>
        <p className="muted">Натисніть «Увійти через дашборд» у програмі ще раз.</p>
      </Frame>
    );
  }

  // Not signed in yet: remember where to come back to, then send them through the normal login.
  if (!token) {
    sessionStorage.setItem("afterLogin", window.location.pathname + window.location.search);
    return <Navigate to="/login" replace />;
  }

  return (
    <Frame>
      {error ? (
        <>
          <p>{error}</p>
          <p className="muted">Поверніться в програму й спробуйте ще раз.</p>
        </>
      ) : (
        <p>Підтверджуємо вхід у трекер часу…</p>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-screen">
      <div className="login-card" style={{ textAlign: "center", gap: 8 }}>
        <div className="login-brand">
          <Logo size={40} variant="red" />
          <span>UTS Dashboard</span>
        </div>
        {children}
      </div>
    </div>
  );
}
