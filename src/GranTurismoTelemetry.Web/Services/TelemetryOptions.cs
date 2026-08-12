namespace GranTurismoTelemetry.Web.Services;

/// <summary>
/// Runtime configuration bound from the "Telemetry" section of appsettings.json
/// (and overridable via <c>--Telemetry:*</c> command-line arguments).
/// </summary>
public sealed class TelemetryOptions
{
    public const string SectionName = "Telemetry";

    /// <summary>IP address of the PS5 running Gran Turismo 7.</summary>
    public string Ps5Ip { get; set; } = "127.0.0.1";

    /// <summary>UDP port on the PS5 that receives the heartbeat.</summary>
    public int SendPort { get; set; } = 33739;

    /// <summary>UDP port this app binds to for incoming telemetry.</summary>
    public int ReceivePort { get; set; } = 33740;

    /// <summary>
    /// When true, no UDP client is started and a synthetic data source is used
    /// instead. Handy for local UI development.
    /// </summary>
    public bool UseSimulator { get; set; } = true;

    /// <summary>
    /// Throttle server->client broadcast frequency (Hz). GT7 sends ~60 Hz; a
    /// lower value reduces browser cost without hurting perceived smoothness.
    /// </summary>
    public int BroadcastHz { get; set; } = 30;
}
