import type { ReactNode } from 'react';
import { useHotel } from '../App';
import { useApi } from '../ui';

/** Logo heights for printed reports; the server's PDF header uses the same sizes. */
export const REPORT_LOGO_PX = { small: 32, medium: 46, large: 62 } as const;

/**
 * Wraps a page that is printed from the browser (Print / PDF). The header - hotel logo, hotel name, report title,
 * the hotel's system number and the platform version - and the footer repeat on EVERY printed page: browsers repeat
 * a table's header and footer groups on each page. On screen the frame is invisible.
 */
export function PrintFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { base, me } = useHotel();
  const h = useApi<any>(`${base}/reports/header`).data;
  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(h?.timezone ? { timeZone: h.timezone } : {}) });
  return (
    <table className="print-frame">
      <thead><tr><td>
        <div className="ph">
          {h?.logo && <img src={h.logo} alt="" style={{ height: REPORT_LOGO_PX[(h.logoSize ?? 'medium') as keyof typeof REPORT_LOGO_PX] }} />}
          <div className="ph-main"><strong>{h?.name ?? ''}</strong><span className="ph-title">{title}</span>{subtitle && <span>{subtitle}</span>}</div>
          <div className="ph-meta"><b>System no. {h?.systemNumber ?? 'not set'}</b><span>Staff Mobile Key {h?.version ?? ''}</span><span>Printed {printed}</span></div>
        </div>
      </td></tr></thead>
      <tfoot><tr><td>
        <div className="pf"><span>Printed by {me.displayName}</span>{h?.footer && <span>{h.footer}</span>}</div>
      </td></tr></tfoot>
      <tbody><tr><td>{children}</td></tr></tbody>
    </table>
  );
}
