#!/usr/bin/env python3
"""
BLE end-to-end test script for Lucy blue-wifi pairing + WiFi provisioning.

Scans for the Lucy-Setup BLE device, connects, reads/writes GATT
characteristics, performs the OTP-based binding flow via user-center,
and configures WiFi. All data exchanges are logged for documentation.

Usage:
    python3 scripts/ble-test-flow.py \
        --phone 18888888888 --password cephalon.boss \
        --wifi-ssid cephalon-bak --wifi-password duannao2023
"""

import argparse
import asyncio
import json
import time
import urllib.request
import urllib.error

from bleak import BleakClient, BleakScanner

# GATT UUIDs (from blue-wifi agent.go)
SERVICE_UUID                = "7f0c0000-4f31-4a32-a917-9a4ec0b20001"
DEVICE_INFO_UUID            = "7f0c0001-4f31-4a32-a917-9a4ec0b20001"
NETWORK_STATUS_UUID         = "7f0c0002-4f31-4a32-a917-9a4ec0b20001"
WIFI_CONFIG_UUID            = "7f0c0003-4f31-4a32-a917-9a4ec0b20001"
WIFI_SCAN_UUID              = "7f0c0004-4f31-4a32-a917-9a4ec0b20001"
LUCY_PAIRING_INFO_UUID      = "7f0c0005-4f31-4a32-a917-9a4ec0b20001"
LUCY_PAIRING_REQUEST_UUID   = "7f0c0006-4f31-4a32-a917-9a4ec0b20001"

USER_CENTER_BASE = "https://test.unicorn.org.cn/cephalon/user-center"
LUCY_SERVER_BASE = "https://test.unicorn.org.cn/aiden/lucy-server"

exchanges = []

def log_exchange(direction: str, step: str, data):
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "direction": direction,
        "step": step,
        "data": data,
    }
    exchanges.append(entry)
    arrow = "-->" if direction == "write" else "<--"
    print(f"\n{'='*60}")
    print(f"  [{direction.upper()}] {step}")
    print(f"  {arrow} {json.dumps(data, ensure_ascii=False, indent=2)}")
    print(f"{'='*60}")


def http_post(url: str, body: dict, token: str = None) -> dict:
    """Simple HTTP POST with JSON body."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            return {"status": resp.status, "body": result}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            body_json = json.loads(body_text)
        except Exception:
            body_json = body_text
        return {"status": e.code, "body": body_json}


def http_put(url: str, body: dict = None, token: str = None) -> dict:
    """Simple HTTP PUT."""
    data = json.dumps(body).encode("utf-8") if body else b""
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            try:
                result = json.loads(raw)
            except Exception:
                result = raw.decode("utf-8", errors="replace")
            return {"status": resp.status, "body": result}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            body_json = json.loads(body_text)
        except Exception:
            body_json = body_text
        return {"status": e.code, "body": body_json}


def http_get(url: str, token: str = None) -> dict:
    """Simple HTTP GET."""
    req = urllib.request.Request(url, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            return {"status": resp.status, "body": result}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            body_json = json.loads(body_text)
        except Exception:
            body_json = body_text
        return {"status": e.code, "body": body_json}


async def main():
    parser = argparse.ArgumentParser(description="Lucy BLE test flow")
    parser.add_argument("--phone", required=True, help="Phone number for login")
    parser.add_argument("--password", required=True, help="Password for login")
    parser.add_argument("--wifi-ssid", default="", help="WiFi SSID to configure")
    parser.add_argument("--wifi-password", default="", help="WiFi password")
    parser.add_argument("--device-name", default="Lucy-Setup", help="BLE device name")
    parser.add_argument("--scan-timeout", type=float, default=15.0)
    args = parser.parse_args()

    # ── Step 1: Scan for BLE device ──────────────────────────────
    print(f"\n[1/7] Scanning for BLE device '{args.device_name}'...")
    device = await BleakScanner.find_device_by_name(
        args.device_name, timeout=args.scan_timeout
    )
    if not device:
        print(f"ERROR: Device '{args.device_name}' not found within {args.scan_timeout}s")
        return
    log_exchange("read", "BLE scan result", {
        "name": device.name,
        "address": device.address,
        "rssi": device.rssi if hasattr(device, 'rssi') else "N/A",
    })

    async with BleakClient(device) as client:
        print(f"\nConnected to {device.name} ({device.address})")

        # ── Step 2: Read device_info ─────────────────────────────
        print("\n[2/7] Reading device_info characteristic...")
        raw = await client.read_gatt_char(DEVICE_INFO_UUID)
        device_info = json.loads(raw.decode("utf-8"))
        log_exchange("read", "device_info (UUID: 7f0c0001)", device_info)

        # ── Step 3: Read network_status ──────────────────────────
        print("\n[3/7] Reading network_status characteristic...")
        raw = await client.read_gatt_char(NETWORK_STATUS_UUID)
        net_status = json.loads(raw.decode("utf-8"))
        log_exchange("read", "network_status (UUID: 7f0c0002)", net_status)

        # ── Step 4: Read lucy_pairing_info ───────────────────────
        print("\n[4/7] Reading lucy_pairing_info characteristic...")
        raw = await client.read_gatt_char(LUCY_PAIRING_INFO_UUID)
        pairing_info = json.loads(raw.decode("utf-8"))
        log_exchange("read", "lucy_pairing_info (UUID: 7f0c0005)", pairing_info)

        cdi = pairing_info.get("channel_device_id", "")
        binding_status = pairing_info.get("binding_status", "")
        print(f"  channel_device_id: {cdi}")
        print(f"  binding_status: {binding_status}")

        if binding_status != "pending":
            print(f"WARNING: Device already bound (status={binding_status})")

        # ── Step 5: Request OTP via BLE ──────────────────────────
        print("\n[5/7] Requesting OTP (write to lucy_pairing_request)...")
        request_id = str(int(time.time() * 1000))
        bind_request = {"request_id": request_id}
        log_exchange("write", "lucy_pairing_request (UUID: 7f0c0006)", bind_request)
        await client.write_gatt_char(
            LUCY_PAIRING_REQUEST_UUID,
            json.dumps(bind_request).encode("utf-8"),
        )

        # Wait for OTP to be populated, then re-read pairing info
        print("  Waiting for OTP (up to 10s)...")
        await asyncio.sleep(2)
        raw = await client.read_gatt_char(LUCY_PAIRING_INFO_UUID)
        pairing_with_otp = json.loads(raw.decode("utf-8"))
        log_exchange("read", "lucy_pairing_info with OTP overlay (UUID: 7f0c0005)", pairing_with_otp)

        otp = pairing_with_otp.get("otp", "")
        if not otp:
            print("ERROR: No OTP received. Check gateway and IPC logs.")
            # Save exchanges even on failure
            _save_exchanges(exchanges)
            return

        print(f"  OTP received: {otp}")

        # ── Step 6: Login + Bind via user-center API ─────────────
        print("\n[6/7] Logging in to user-center and binding device...")

        # 6a. Login (user-center)
        login_body = {"phone": args.phone, "pwd": args.password, "way": "phone_pwd"}
        log_exchange("write", "POST /v1/login (user-center)", {
            "url": f"{USER_CENTER_BASE}/v1/login",
            "body": login_body,
        })
        login_resp = http_post(f"{USER_CENTER_BASE}/v1/login", login_body)
        log_exchange("read", "login response", login_resp)

        if login_resp["status"] != 200:
            print(f"ERROR: Login failed: {login_resp}")
            _save_exchanges(exchanges)
            return

        body = login_resp["body"] if isinstance(login_resp["body"], dict) else {}
        # Token may be at top level or nested in data/result
        token = (
            body.get("access_token")
            or body.get("token")
            or body.get("jwt")
            or (body.get("data", {}) or {}).get("access_token")
            or (body.get("data", {}) or {}).get("token")
            or (body.get("result", {}) or {}).get("access_token")
            or (body.get("result", {}) or {}).get("token")
            or ""
        )
        print(f"  Login successful, token: {token[:20]}...")

        # 6b. Bind device (lucy-server) — requires OTP from BLE step
        bind_url = f"{LUCY_SERVER_BASE}/v1/channels/lucy/devices/device-bindings"
        bind_body = {"otp": otp}
        log_exchange("write", "PUT /v1/channels/lucy/devices/device-bindings (lucy-server)", {
            "url": bind_url,
            "method": "PUT",
            "body": bind_body,
        })
        bind_resp = http_put(bind_url, body=bind_body, token=token)
        log_exchange("read", "bind response", bind_resp)

        if bind_resp["status"] != 200:
            print(f"ERROR: Bind failed: {bind_resp}")
            _save_exchanges(exchanges)
            return

        print(f"  Binding successful!")

        # Wait for gateway to detect binding
        print("  Waiting for gateway to complete binding (10s)...")
        await asyncio.sleep(10)

        # Re-read pairing info to confirm bound status
        raw = await client.read_gatt_char(LUCY_PAIRING_INFO_UUID)
        pairing_final = json.loads(raw.decode("utf-8"))
        log_exchange("read", "lucy_pairing_info after binding (UUID: 7f0c0005)", pairing_final)

        # ── Step 7: WiFi Configuration ───────────────────────────
        if args.wifi_ssid:
            print(f"\n[7/7] Configuring WiFi: {args.wifi_ssid}...")

            # 7a. Scan WiFi networks
            scan_request = {"action": "scan"}
            log_exchange("write", "wifi_scan request (UUID: 7f0c0004)", scan_request)
            await client.write_gatt_char(
                WIFI_SCAN_UUID,
                json.dumps(scan_request).encode("utf-8"),
            )
            await asyncio.sleep(5)
            raw = await client.read_gatt_char(WIFI_SCAN_UUID)
            wifi_scan = json.loads(raw.decode("utf-8"))
            log_exchange("read", "wifi_scan response (UUID: 7f0c0004)", wifi_scan)

            # 7b. Configure WiFi
            wifi_config = {
                "ssid": args.wifi_ssid,
                "password": args.wifi_password,
                "hidden": False,
            }
            log_exchange("write", "wifi_config (UUID: 7f0c0003)", wifi_config)
            await client.write_gatt_char(
                WIFI_CONFIG_UUID,
                json.dumps(wifi_config).encode("utf-8"),
            )
            await asyncio.sleep(5)

            # 7c. Read network status
            raw = await client.read_gatt_char(NETWORK_STATUS_UUID)
            net_final = json.loads(raw.decode("utf-8"))
            log_exchange("read", "network_status after WiFi config (UUID: 7f0c0002)", net_final)
        else:
            print("\n[7/7] Skipping WiFi configuration (no --wifi-ssid)")

    _save_exchanges(exchanges)


def _save_exchanges(data):
    out_path = "scripts/ble-test-exchanges.json"
    with open(out_path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n{'='*60}")
    print(f"  All {len(data)} data exchanges saved to: {out_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    asyncio.run(main())
