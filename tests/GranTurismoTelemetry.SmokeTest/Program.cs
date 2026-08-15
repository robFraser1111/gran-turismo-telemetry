// Smoke-test for the GT7 telemetry pipeline.
//
// 1. Round-trips a fabricated telemetry packet through Salsa20 (encrypt -> decrypt)
//    and asserts the parsed fields match the original.
// 2. If the web app is running locally with UseSimulator=false and Ps5Ip=127.0.0.1,
//    also sends a heartbeat-triggered encrypted packet to it via UDP and checks
//    /api/telemetry/latest reflects the same values.

using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using GranTurismoTelemetry.Web.Gt7;

Console.WriteLine("=== GT7 telemetry smoke test ===");

// ---- 1. In-memory round trip ----------------------------------------------
{
    byte[] plaintext = new byte[0x140];
    // Magic "G7S0"
    BinaryPrimitives.WriteUInt32LittleEndian(plaintext.AsSpan(0, 4), 0x47375330u);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x3C, 4), 7250.5f);      // rpm
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x4C, 4), 55.55f);       // speed m/s
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x50, 4), 160.0f);       // boostKpa
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x44, 4), 87.5f);        // fuel level
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x48, 4), 100f);         // fuel cap
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x60, 4), 90.0f);        // tire FL
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x64, 4), 91.5f);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x68, 4), 92.0f);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x6C, 4), 93.0f);
    BinaryPrimitives.WriteInt32LittleEndian(plaintext.AsSpan(0x70, 4), 12345);         // packetId
    BinaryPrimitives.WriteInt16LittleEndian(plaintext.AsSpan(0x74, 2), 3);             // lap
    BinaryPrimitives.WriteInt16LittleEndian(plaintext.AsSpan(0x76, 2), 10);            // totalLaps
    BinaryPrimitives.WriteInt16LittleEndian(plaintext.AsSpan(0x8A, 2), 8500);          // maxRpm
    plaintext[0x90] = 0x04;                                                            // gear 4, no shift hint
    plaintext[0x91] = 200;                                                             // throttle
    plaintext[0x92] = 40;                                                              // brake
    // Wheel block: angular speed (rad/s) at 0xA4, tire radius at 0xB4, suspension
    // height at 0xC4. The speeds are picked so radius * rad/s == the 55.55 m/s
    // ground speed above, which is what the dashboard's slip check compares.
    const float tireRadius = 0.33f;
    const float wheelRadS  = 55.55f / tireRadius;
    for (int i = 0; i < 4; i++)
    {
        BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0xA4 + i * 4, 4), wheelRadS);
        BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0xB4 + i * 4, 4), tireRadius);
        BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0xC4 + i * 4, 4), 0.05f + i);
    }
    // Encrypt: build a ciphertext whose IV bytes at 0x40..0x44 equal the chosen
    // literal, so the receiver derives the same Salsa20 nonce we used.
    byte[] cipher = Gt7UdpClient.EncryptForTest(plaintext, 0x12345678u);

    // Decrypt via the receiver's public path
    var packet = Gt7UdpClient.TryDecodePacket(cipher);
    if (packet is null) throw new Exception("Decode failed");

    Require("rpm",       Math.Abs(packet.EngineRpm - 7250.5f) < 0.01f);
    Require("speed",     Math.Abs(packet.SpeedMps - 55.55f) < 0.01f);
    Require("boostKpa",  Math.Abs(packet.BoostKpa - 160.0f) < 0.01f);
    Require("fuelLevel", Math.Abs(packet.FuelLevel - 87.5f) < 0.01f);
    Require("tireFL",    Math.Abs(packet.TireTempFL - 90.0f) < 0.01f);
    Require("gear",      packet.CurrentGear == 4);
    Require("throttle",  packet.Throttle == 200);
    Require("brake",     packet.Brake == 40);
    Require("packetId",  packet.PacketId == 12345);
    Require("lap",       packet.CurrentLap == 3 && packet.TotalLaps == 10);

    Require("wheelSpeedFL", Math.Abs(packet.WheelSpeedFL - wheelRadS) < 0.01f);
    Require("wheelSpeedRR", Math.Abs(packet.WheelSpeedRR - wheelRadS) < 0.01f);
    Require("tireRadiusFL", Math.Abs(packet.TireRadiusFL - tireRadius) < 0.001f);
    Require("tireRadiusRR", Math.Abs(packet.TireRadiusRR - tireRadius) < 0.001f);
    Require("suspensionFL", Math.Abs(packet.SuspensionFL - 0.05f) < 0.001f);
    Require("suspensionRR", Math.Abs(packet.SuspensionRR - 3.05f) < 0.001f);
    // Free-rolling wheels must agree with ground speed, otherwise the dashboard
    // marks every tire dirty (brown) as soon as the car starts moving.
    Require("wheelLinearSpeedMatchesGroundSpeed",
        Math.Abs(packet.WheelSpeedFL * packet.TireRadiusFL - packet.SpeedMps) < 0.05f);

    Console.WriteLine("OK  in-memory round trip: all fields match");
}

// ---- 2. Optional: live UDP into a locally running receiver ----------------
if (args.Length > 0 && args[0] == "--live")
{
    Console.WriteLine("Attempting live UDP round trip to http://localhost:5080 ...");

    // Craft another packet and send it to the app's receive port (33740).
    byte[] plaintext = new byte[0x140];
    BinaryPrimitives.WriteUInt32LittleEndian(plaintext.AsSpan(0, 4), 0x47375330u);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x3C, 4), 4200f);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x4C, 4), 33.3f);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x44, 4), 42f);
    BinaryPrimitives.WriteSingleLittleEndian(plaintext.AsSpan(0x48, 4), 100f);
    plaintext[0x90] = 0x02;
    plaintext[0x91] = 128;
    byte[] cipher = Gt7UdpClient.EncryptForTest(plaintext, 0xABCDEF01u);

    using (var udp = new UdpClient())
    {
        var ep = new IPEndPoint(IPAddress.Loopback, 33740);
        await udp.SendAsync(cipher, cipher.Length, ep);
    }
    Console.WriteLine("  UDP packet sent to :33740");

    await Task.Delay(500);

    using var http = new HttpClient { BaseAddress = new Uri("http://localhost:5080/") };
    var s = await http.GetFromJsonAsync<Dictionary<string, object>>("api/telemetry/latest");
    if (s is null) { Console.Error.WriteLine("FAIL: no latest packet"); return 1; }

    string rpm    = s["engineRpm"].ToString() ?? "";
    string gear   = s["currentGear"].ToString() ?? "";
    string thr    = s["throttle"].ToString() ?? "";
    Console.WriteLine($"  server reports: rpm={rpm}, gear={gear}, throttle={thr}");
    if (!rpm.StartsWith("4200")) { Console.Error.WriteLine("FAIL: rpm mismatch"); return 1; }
    if (gear != "2")             { Console.Error.WriteLine("FAIL: gear mismatch"); return 1; }
    if (thr != "128")            { Console.Error.WriteLine("FAIL: throttle mismatch"); return 1; }
    Console.WriteLine("OK  live UDP round trip");
}
return 0;

static void Require(string name, bool ok)
{
    if (!ok) throw new Exception($"assertion failed: {name}");
}
