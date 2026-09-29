import type { ReactNode } from 'react'

export function MetricCard({ label, value, foot, icon }: { label: string; value: string; foot: ReactNode; icon: ReactNode }) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">{foot}</div>
    </article>
  )
}
