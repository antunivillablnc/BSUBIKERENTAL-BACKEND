import sys
import json
from datetime import datetime, timedelta
from typing import List, Dict, Any

import pandas as pd

try:
    from prophet import Prophet  # new package name
except Exception:  # pragma: no cover
    # fallback for older installs
    from fbprophet import Prophet  # type: ignore


def summarize_next_month(df_fcst: pd.DataFrame) -> Dict[str, Any]:
    today = pd.Timestamp.utcnow().normalize()
    # next calendar month window
    first_next_month = (today + pd.offsets.MonthBegin(1)).normalize()
    first_month_after = (first_next_month + pd.offsets.MonthBegin(1)).normalize()
    mask = (df_fcst['ds'] >= first_next_month) & (df_fcst['ds'] < first_month_after)
    sub = df_fcst.loc[mask]
    return {
        "start": first_next_month.strftime('%Y-%m-%d'),
        "end": first_month_after.strftime('%Y-%m-%d'),
        "sumMean": float(sub['yhat'].sum()) if not sub.empty else 0.0,
        "sumLower": float(sub['yhat_lower'].sum()) if not sub.empty else 0.0,
        "sumUpper": float(sub['yhat_upper'].sum()) if not sub.empty else 0.0,
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw or '{}')

    # Expect { series: [{ ds: 'YYYY-MM-DD', y: number }], horizonWeeks: 12 }
    series = payload.get('series', [])
    horizon_weeks = int(payload.get('horizonWeeks', 12))

    if not series:
        print(json.dumps({"forecast": [], "nextMonth": {"sumMean": 0, "sumLower": 0, "sumUpper": 0}}))
        return

    df = pd.DataFrame(series)
    # Ensure weekly frequency starting Monday
    df['ds'] = pd.to_datetime(df['ds'])
    df = df.sort_values('ds')

    # Prophet model with weekly seasonality only
    m = Prophet(weekly_seasonality=True, daily_seasonality=False, yearly_seasonality=True)
    m.fit(df)

    future = m.make_future_dataframe(periods=horizon_weeks, freq='W-MON', include_history=False)
    fcst = m.predict(future)
    out = fcst[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]

    next_month = summarize_next_month(out)

    result = {
        "forecast": [
            {
                "ds": r['ds'].strftime('%Y-%m-%d'),
                "yhat": float(r['yhat']),
                "yhat_lower": float(r['yhat_lower']),
                "yhat_upper": float(r['yhat_upper']),
            }
            for _, r in out.iterrows()
        ],
        "nextMonth": next_month,
    }

    print(json.dumps(result))


if __name__ == '__main__':
    main()


