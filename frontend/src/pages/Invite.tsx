import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { acceptInvite, fetchInvite, hiringError } from "../api";
import { Logo } from "../components/Logo";

/**
 * 🎓 «Встановіть пароль» — вхід кандидата за посиланням-запрошенням (найм, прохід 2a).
 * Рекрутер копіює посилання в картці й надсилає сам. Після пароля людина одразу потрапляє в «Навчання».
 */
export function Invite() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ name: string | null; login: string; expiresAt: string } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchInvite(token).then(setInfo).catch((e) => setFatal(hiringError(e)));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError("Пароль — щонайменше 8 символів");
    if (!/\d/.test(pw) || !/\D/.test(pw)) return setError("Пароль має містити і літери, і цифри");
    if (pw !== pw2) return setError("Паролі не збігаються");
    setBusy(true);
    try {
      const r = await acceptInvite(token, pw);
      localStorage.setItem("token", r.token);
      navigate("/training", { replace: true });
    } catch (err) {
      setError(hiringError(err));
      setBusy(false);
    }
  }

  const expires = info ? new Date(info.expiresAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="login-screen">
      <form onSubmit={submit} className="login-card">
        <div className="login-brand">
          <Logo size={40} variant="red" />
          <span>UTS Dashboard</span>
        </div>
        {!info && !fatal && <p>Перевіряємо посилання…</p>}
        {fatal && (
          <>
            <p className="login-error">{fatal}</p>
            <button type="button" onClick={() => navigate("/login")}>До входу</button>
          </>
        )}
        {info && (
          <>
            <p style={{ margin: "0 0 4px" }}>{info.name ? <><b>{info.name}</b>, вітаємо!</> : "Вітаємо!"} Встановіть пароль, щоб почати навчання.</p>
            <p style={{ margin: "0 0 10px", fontSize: 13, opacity: 0.75 }}>
              Ваш логін: <b>{info.login}</b>. Посилання чинне до {expires} і спрацьовує один раз. Пароль — від 8 символів, літери й цифри.
            </p>
            <input type="password" placeholder="Новий пароль" autoComplete="new-password"
              value={pw} onChange={(e) => setPw(e.target.value)} required />
            <input type="password" placeholder="Повторіть пароль" autoComplete="new-password"
              value={pw2} onChange={(e) => setPw2(e.target.value)} required />
            {error && <p className="login-error">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? "Зберігаємо…" : "Встановити пароль і увійти"}</button>
          </>
        )}
      </form>
    </div>
  );
}
