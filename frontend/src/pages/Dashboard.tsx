import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";
import { fetchFunnel, type FunnelStage } from "../api";

const STAGE_LABELS: Record<string, string> = {
  lead_taken: "Ліди в роботі",
  quote_requested: "Запит КП",
  approved: "Погоджено",
  invoiced: "Рахунок виставлено",
  paid: "Оплачено",
};

export function Dashboard() {
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFunnel({})
      .then(setStages)
      .finally(() => setLoading(false));
  }, []);

  const chartData = stages.map((s) => ({
    name: STAGE_LABELS[s.funnel_stage] ?? s.funnel_stage,
    count: Number(s.deal_count),
    amount: Number(s.total_amount),
  }));

  return (
    <div style={{ padding: 24 }}>
      <h2>Воронка продажів</h2>
      {loading ? (
        <p>Завантаження...</p>
      ) : (
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="count" fill="#4f46e5" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
