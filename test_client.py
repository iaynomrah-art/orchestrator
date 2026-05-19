import os
import asyncio
import json
import uuid
from dotenv import load_dotenv
from supabase._async.client import create_client, AsyncClient
from app.helper.system import get_machine_guid

# Configuration
APP_NAME = "PairTradingServer"
APPDATA_DIR = os.path.join(os.getenv('APPDATA'), APP_NAME) if os.getenv('APPDATA') else os.path.abspath(os.path.join(os.getcwd(), ".data"))
SESSION_FILE = os.path.join(APPDATA_DIR, "session.json")

# Set this to a GUID string to target a specific device, or None to use the local session
FIXED_GUID = None 

def read_guid():
    if not os.path.exists(SESSION_FILE):
        print(f"Error: Session file not found at {SESSION_FILE}")
        return None
    try:
        with open(SESSION_FILE, "r") as f:
            data = json.load(f)
            return data.get("guid")
    except Exception as e:
        print(f"Error reading session file: {e}")
        return None

async def main():
    load_dotenv()
    url = os.getenv("PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_SECRET_KEY")
    
    if not url or not key:
        print("Error: Missing Supabase credentials in .env")
        return

    # Use fixed GUID if provided, otherwise read from session, otherwise use machine GUID
    guid = FIXED_GUID if FIXED_GUID else read_guid()
    
    if not guid:
        print("No session found. Falling back to actual Machine GUID...")
        guid = get_machine_guid()
        
    if not guid:
        print("Error: Could not find or generate a GUID.")
        return

    print(f"Targeting Unit GUID: {guid}")
    supabase: AsyncClient = await create_client(url, key)
    
    channel_name = f"unit_{guid}"
    channel = supabase.channel(channel_name)

    # Listen for responses
    def on_pong(payload):
        print(f"\n[REPLY] Received PONG: {payload}")

    def on_status(payload):
        print(f"\n[REPLY] Status Update: {payload}")

    def on_result(payload):
        print(f"\n[REPLY] Trade Result: {payload}")

    channel.on_broadcast("pong", on_pong)
    channel.on_broadcast("status_update", on_status)
    channel.on_broadcast("trade_result", on_result)

    await channel.subscribe()
    print(f"Subscribed to {channel_name}. You are now acting as the Frontend.")

    async def send_ping():
        tx_id = str(uuid.uuid4())
        print(f"Sending PING (tx: {tx_id})...")
        await channel.send_broadcast(event="ping", data={"transaction_id": tx_id})

    async def send_trade(platform="ctrader"):
        tx_id = str(uuid.uuid4())
        print(f"Sending RUN_{platform.upper()} (tx: {tx_id})...")
        payload = {
            "transaction_id": tx_id,
            "account_id": "1787007",
            "password": "d7G3!sxj",
            "username": "iru.xfnite@gmail.com",
            "order_amount": "0.1",
            "purchase_type": "sell",
            "symbol": "XAUUSD",
            "stop_loss": "5020",
            "take_profit": "2300",
            "server": "FPR",
            "operation" : "input-order"
        }
        event = f"run_{platform}"
        await channel.send_broadcast(event=event, data=payload)

    print("\n--- Automation Test Client ---")
    print("1. Send Ping")
    print("2. Send Test cTrader Command")
    print("3. Send Test TradeLocker Command")
    print("q. Quit")

    while True:
        try:
            choice = await asyncio.to_thread(input, "\nChoice > ")
            if choice == '1':
                await send_ping()
            elif choice == '2':
                await send_trade("ctrader")
            elif choice == '3':
                await send_trade("tradelocker")
            elif choice == 'q':
                break
            else:
                print("Invalid choice.")
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
