using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace GranTurismoTelemetry.Web.Gt7;

/// <summary>
/// Connects to a PS5 running Gran Turismo 7, sends the periodic heartbeat and
/// decodes the encrypted telemetry response. Exposes decoded packets as an
/// async event / channel via the <see cref="PacketReceived"/> callback.
/// </summary>
public sealed class Gt7UdpClient : IAsyncDisposable
{
    // Default network configuration used by GT7 (see community reversing docs).
    public const int DefaultSendPort    = 33739; // PS5 listens here
    public const int DefaultReceivePort = 33740; // PC receives here

    private const string KeySeed = "Simulator Interface Packet GT7 ver 0.0";
    private static readonly byte[] Key = InitKey();
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(10);

    private readonly ILogger<Gt7UdpClient> _log;
    private readonly IPAddress _ps5;
    private readonly int _sendPort;
    private readonly int _receivePort;

    public Gt7UdpClient(IPAddress ps5, int sendPort, int receivePort, ILogger<Gt7UdpClient> log)
    {
        _ps5 = ps5;
        _sendPort = sendPort;
        _receivePort = receivePort;
        _log = log;
    }

    /// <summary>Fired whenever a valid telemetry packet is decoded.</summary>
    public event Action<TelemetryPacket>? PacketReceived;

    /// <summary>Fired whenever a UDP datagram is received (regardless of size/validity).
    /// Argument is the datagram size in bytes. Useful for diagnostics.</summary>
    public event Action<int>? RawPacketReceived;

    /// <summary>Fired when a datagram of plausible size arrived but couldn't be decoded
    /// (bad Salsa20 output, wrong magic, malformed structure). Argument is a short reason.</summary>
    public event Action<string>? DecodeFailed;

    public async Task RunAsync(CancellationToken ct)
    {
        using var udp = new UdpClient(_receivePort);
        udp.Client.ReceiveBufferSize = 1 << 16;
        DisableUdpConnReset(udp);
        var endpoint = new IPEndPoint(_ps5, _sendPort);

        _log.LogInformation("GT7 UDP client started (PS5 {Ip}:{SendPort}, listen :{ReceivePort})",
            _ps5, _sendPort, _receivePort);

        // Send an initial heartbeat immediately, then keep pinging periodically
        // (GT7 stops streaming if we go silent for too long).
        await SendHeartbeatAsync(udp, endpoint, ct);
        _ = Task.Run(() => HeartbeatLoop(udp, endpoint, ct), ct);

        bool firstOkLogged = false;
        int decodeFailStreak = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var result = await udp.ReceiveAsync(ct);
                RawPacketReceived?.Invoke(result.Buffer.Length);

                // GT7's standard 'A'-heartbeat response is exactly 296 (0x128) bytes.
                // Some builds send larger packets; accept anything from 0x128 upwards.
                if (result.Buffer.Length < 0x128)
                {
                    var reason = $"short packet ({result.Buffer.Length} bytes, need >= {0x128})";
                    _log.LogDebug("GT7 recv: {Reason} from {From} - ignoring", reason, result.RemoteEndPoint);
                    DecodeFailed?.Invoke(reason);
                    continue;
                }

                var packet = TryDecodePacket(result.Buffer, out string? failReason);
                if (packet is not null)
                {
                    decodeFailStreak = 0;
                    if (!firstOkLogged)
                    {
                        firstOkLogged = true;
                        _log.LogInformation(
                            "GT7 telemetry stream is live (first valid packet from {From}, {Len} bytes)",
                            result.RemoteEndPoint, result.Buffer.Length);
                    }
                    PacketReceived?.Invoke(packet);
                }
                else
                {
                    decodeFailStreak++;
                    // Log the first failure loudly, and then only occasionally, so we don't spam.
                    if (decodeFailStreak == 1 || decodeFailStreak % 120 == 0)
                    {
                        _log.LogWarning(
                            "GT7 recv: failed to decode packet from {From} ({Len} bytes): {Reason} (streak={Streak})",
                            result.RemoteEndPoint, result.Buffer.Length, failReason, decodeFailStreak);
                    }
                    DecodeFailed?.Invoke(failReason ?? "unknown");
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "GT7 receive error");
                await Task.Delay(500, ct);
            }
        }
    }

    private async Task HeartbeatLoop(UdpClient udp, IPEndPoint ep, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(HeartbeatInterval, ct);
                await SendHeartbeatAsync(udp, ep, ct);
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task SendHeartbeatAsync(UdpClient udp, IPEndPoint ep, CancellationToken ct)
    {
        // GT7 accepts a single-byte "A" as heartbeat trigger.
        await udp.SendAsync(new byte[] { (byte)'A' }, 1, ep);
        _log.LogTrace("Heartbeat sent to {Endpoint}", ep);
    }

    /// <summary>Tries to decrypt and parse a raw UDP payload. Returns null on failure.</summary>
    internal static TelemetryPacket? TryDecodePacket(byte[] raw)
        => TryDecodePacket(raw, out _);

    /// <summary>
    /// Same as <see cref="TryDecodePacket(byte[])"/> but also returns a short human-readable
    /// reason string on failure (useful for diagnostics / status endpoint).
    /// </summary>
    internal static TelemetryPacket? TryDecodePacket(byte[] raw, out string? failReason)
    {
        try
        {
            var buffer = (byte[])raw.Clone();
            Decrypt(buffer);

            // Magic bytes: after decryption the first 4 bytes must be "G7S0"
            // (0x30 0x53 0x37 0x47 as little-endian int -> 0x47375330).
            var magic = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(0, 4));
            if (magic != 0x47375330u)
            {
                failReason = $"bad magic 0x{magic:X8} after decrypt (expected 0x47375330 'G7S0')";
                return null;
            }

            failReason = null;
            return TelemetryPacket.Parse(buffer);
        }
        catch (Exception ex)
        {
            failReason = $"{ex.GetType().Name}: {ex.Message}";
            return null;
        }
    }

    /// <summary>
    /// Decrypts the packet in place. The IV is derived from bytes 0x40..0x44 of
    /// the ciphertext XORed with the magic constant 0xDEADBEAF.
    /// </summary>
    internal static void Decrypt(byte[] buffer)
    {
        uint oivInt = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(0x40, 4));
        Span<byte> nonce = stackalloc byte[8];
        BuildNonce(oivInt, nonce);
        Salsa20.XorInPlace(Key, nonce, buffer);
    }

    /// <summary>
    /// Test-only: builds a ciphertext that will decrypt back to <paramref name="plaintext"/>
    /// when passed to <see cref="TryDecodePacket"/>. The four IV bytes at offset 0x40 in
    /// the returned ciphertext are literally <paramref name="chosenCiphertextIv"/>, which
    /// is what the receiver uses to derive the Salsa20 nonce.
    /// </summary>
    internal static byte[] EncryptForTest(byte[] plaintext, uint chosenCiphertextIv)
    {
        Span<byte> nonce = stackalloc byte[8];
        BuildNonce(chosenCiphertextIv, nonce);

        byte[] cipher = (byte[])plaintext.Clone();
        Salsa20.XorInPlace(Key, nonce, cipher);
        // Overwrite the IV bytes so the receiver reads back the exact same nonce.
        BinaryPrimitives.WriteUInt32LittleEndian(cipher.AsSpan(0x40, 4), chosenCiphertextIv);
        return cipher;
    }

    private static void BuildNonce(uint oivInt, Span<byte> nonce)
    {
        uint iv1 = oivInt ^ 0xDEADBEAFu;
        BinaryPrimitives.WriteUInt32LittleEndian(nonce.Slice(0, 4), iv1);
        BinaryPrimitives.WriteUInt32LittleEndian(nonce.Slice(4, 4), oivInt);
    }

    /// <summary>
    /// Disable Windows' behavior of surfacing "port unreachable" ICMP responses as
    /// <see cref="SocketException"/> WSAECONNRESET (10054) on the receive path.
    /// Without this, sending a heartbeat to a PS5 that isn't up yet would kill
    /// our receive loop.
    /// </summary>
    private static void DisableUdpConnReset(UdpClient udp)
    {
        if (!OperatingSystem.IsWindows()) return;
        const int SIO_UDP_CONNRESET = -1744830452; // 0x9800000C
        try
        {
            udp.Client.IOControl((IOControlCode)SIO_UDP_CONNRESET, new byte[] { 0 }, null);
        }
        catch (PlatformNotSupportedException) { /* older Windows / non-Windows */ }
    }

    private static byte[] InitKey()
    {
        var raw = Encoding.ASCII.GetBytes(KeySeed);
        var key = new byte[32];
        Array.Copy(raw, key, Math.Min(raw.Length, 32));
        return key;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
