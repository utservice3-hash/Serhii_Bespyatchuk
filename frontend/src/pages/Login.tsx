import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";
import { Logo } from "../components/Logo";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const token = await login(email, password);
      localStorage.setItem("token", token);
      // Somewhere asked to be returned to after signing in — currently only /tracker-auth,
      // which loses its query otherwise and leaves the agent waiting on a port for nothing.
      const back = sessionStorage.getItem("afterLogin");
      sessionStorage.removeItem("afterLogin");
      navigate(back ?? "/", { replace: true });
    } catch {
      setError("Невірний email або пароль");
    }
  }

  return (
    <div className="login-screen">
      <form onSubmit={handleSubmit} className="login-card">
        <div className="login-brand">
          <Logo size={40} variant="red" />
          <span>UTS Dashboard</span>
        </div>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit">Увійти</button>
      </form>
    </div>
  );
}
