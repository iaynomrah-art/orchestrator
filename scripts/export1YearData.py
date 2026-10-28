import MetaTrader5 as mt5
import pandas as pd
import os

print("Connecting to MetaTrader 5...")
if not mt5.initialize():
    print("MT5 initialization failed:", mt5.last_error())
    exit(1)

symbol = "XAUUSD.r"
print(f"Fetching 1 year of M5 candles for {symbol}...")
rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 80000)

if rates is None or len(rates) == 0:
    print("Failed to fetch rates:", mt5.last_error())
    mt5.shutdown()
    exit(1)

print(f"Fetched {len(rates)} M5 candles.")

df = pd.DataFrame(rates)
# Keep columns: time, open, high, low, close, spread
out_df = df[["time", "open", "high", "low", "close", "spread"]]

out_path = os.path.join(os.path.dirname(__file__), "../data/XAUUSD.r_M5.csv")
out_df.to_csv(out_path, index=False)
print(f"Saved {len(out_df)} candles to {out_path}")

first_time = pd.to_datetime(out_df["time"].iloc[0], unit="s")
last_time = pd.to_datetime(out_df["time"].iloc[-1], unit="s")
print(f"Full 1-Year Range: {first_time} to {last_time}")

mt5.shutdown()
