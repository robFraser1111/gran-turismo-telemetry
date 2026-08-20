using System.Buffers.Binary;

namespace GranTurismoTelemetry.Web.Gt7;

/// <summary>
/// Decoded Gran Turismo 7 telemetry packet. Field selection modelled after
/// well-known community documentation (gt-telem, granturismo-python, etc.).
/// All numeric units are SI unless otherwise noted; helper properties expose
/// display-friendly values (km/h, bar, etc.).
/// </summary>
public sealed record TelemetryPacket
{
    // Header
    public int PacketId { get; init; }

    // Position (metres, world space)
    public float PositionX { get; init; }
    public float PositionY { get; init; }
    public float PositionZ { get; init; }

    // Velocity (m/s per axis)
    public float VelocityX { get; init; }
    public float VelocityY { get; init; }
    public float VelocityZ { get; init; }

    // Rotation (quaternion-ish / heading, forwarded verbatim)
    public float RotationPitch { get; init; }
    public float RotationYaw   { get; init; }
    public float RotationRoll  { get; init; }
    public float Heading       { get; init; }

    public float AngularVelocityX { get; init; }
    public float AngularVelocityY { get; init; }
    public float AngularVelocityZ { get; init; }

    public float RideHeight { get; init; }

    // Engine / drivetrain
    public float EngineRpm    { get; init; }
    public float FuelLevel    { get; init; } // percentage 0..100
    public float FuelCapacity { get; init; }
    public float SpeedMps     { get; init; } // metres per second
    public float BoostKpa     { get; init; } // absolute pressure in kPa; gauge = BoostKpa - 100
    public float OilPressure  { get; init; }
    public float WaterTemp    { get; init; } // °C (game always reports 85)
    public float OilTemp      { get; init; } // °C (game always reports 110)

    // Tire temperatures (°C)
    public float TireTempFL { get; init; }
    public float TireTempFR { get; init; }
    public float TireTempRL { get; init; }
    public float TireTempRR { get; init; }

    // Session / lap
    public int   CurrentLap   { get; init; }
    public int   TotalLaps    { get; init; }
    public int   BestLapMs    { get; init; }
    public int   LastLapMs    { get; init; }
    public int   DayProgressionMs { get; init; }
    public int   PreRaceStartPos { get; init; }
    public int   NumCarsPreRace { get; init; }

    public int   AlertMinRpm { get; init; }
    public int   AlertMaxRpm { get; init; }
    public int   CalcMaxSpeedKph { get; init; }

    // Flags (see SimulatorFlags)
    public SimulatorFlags Flags { get; init; }

    public int  CurrentGear   { get; init; } // 0 = neutral, 15 = reverse (raw 0x0F)
    public int  SuggestedGear { get; init; } // 15 = none
    public byte Throttle      { get; init; } // 0..255
    public byte Brake         { get; init; } // 0..255

    // Wheels
    public float WheelSpeedFL { get; init; } // rad/s
    public float WheelSpeedFR { get; init; }
    public float WheelSpeedRL { get; init; }
    public float WheelSpeedRR { get; init; }

    public float TireRadiusFL { get; init; }
    public float TireRadiusFR { get; init; }
    public float TireRadiusRL { get; init; }
    public float TireRadiusRR { get; init; }

    public float SuspensionFL { get; init; }
    public float SuspensionFR { get; init; }
    public float SuspensionRL { get; init; }
    public float SuspensionRR { get; init; }

    // Transmission
    public float ClutchPedal      { get; init; }
    public float ClutchEngagement { get; init; }
    public float RpmAfterClutch   { get; init; }
    public float TransmissionTopSpeedRatio { get; init; }
    public float[] GearRatios     { get; init; } = Array.Empty<float>();
    public int CarCode { get; init; }

    // ---------- Convenience / display ----------
    public double SpeedKph => SpeedMps * 3.6;
    public double SpeedMph => SpeedMps * 2.2369362920544;
    public double BoostBar => (BoostKpa - 100.0) / 100.0;
    public double FuelPercent => FuelCapacity > 0 ? (FuelLevel / FuelCapacity) * 100.0 : FuelLevel;
    public string GearDisplay => CurrentGear switch
    {
        0     => "N",
        15    => "R",
        var g => g.ToString()
    };

    /// <summary>Human-readable suggested gear. Empty when GT7 reports none (15).</summary>
    public string SuggestedGearDisplay => SuggestedGear switch
    {
        0     => "N",
        15    => "",
        var g => g.ToString()
    };

    /// <summary>True when the packet recommends a gear other than the current one.</summary>
    public bool HasSuggestedGear =>
        SuggestedGear is > 0 and < 15 && SuggestedGear != CurrentGear;

    /// <summary>Parses a decrypted GT7 packet. Requires at least 296 (0x128) bytes;
    /// the last field read is <c>CarCode</c> at offset 0x124..0x128.</summary>
    public static TelemetryPacket Parse(ReadOnlySpan<byte> p)
    {
        if (p.Length < 0x128)
            throw new ArgumentException($"Packet too small: {p.Length} bytes (need >= {0x128})", nameof(p));

        var pkt = new TelemetryPacket
        {
            PositionX = ReadFloat(p, 0x04),
            PositionY = ReadFloat(p, 0x08),
            PositionZ = ReadFloat(p, 0x0C),

            VelocityX = ReadFloat(p, 0x10),
            VelocityY = ReadFloat(p, 0x14),
            VelocityZ = ReadFloat(p, 0x18),

            RotationPitch = ReadFloat(p, 0x1C),
            RotationYaw   = ReadFloat(p, 0x20),
            RotationRoll  = ReadFloat(p, 0x24),
            Heading       = ReadFloat(p, 0x28),

            AngularVelocityX = ReadFloat(p, 0x2C),
            AngularVelocityY = ReadFloat(p, 0x30),
            AngularVelocityZ = ReadFloat(p, 0x34),

            RideHeight = ReadFloat(p, 0x38),
            EngineRpm  = ReadFloat(p, 0x3C),
            // 0x40..0x44 is the IV used for decryption (skip)
            FuelLevel    = ReadFloat(p, 0x44),
            FuelCapacity = ReadFloat(p, 0x48),
            SpeedMps     = ReadFloat(p, 0x4C),
            BoostKpa     = ReadFloat(p, 0x50),
            OilPressure  = ReadFloat(p, 0x54),
            WaterTemp    = ReadFloat(p, 0x58),
            OilTemp      = ReadFloat(p, 0x5C),

            TireTempFL = ReadFloat(p, 0x60),
            TireTempFR = ReadFloat(p, 0x64),
            TireTempRL = ReadFloat(p, 0x68),
            TireTempRR = ReadFloat(p, 0x6C),

            PacketId        = BinaryPrimitives.ReadInt32LittleEndian(p.Slice(0x70, 4)),
            CurrentLap      = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x74, 2)),
            TotalLaps       = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x76, 2)),
            BestLapMs       = BinaryPrimitives.ReadInt32LittleEndian(p.Slice(0x78, 4)),
            LastLapMs       = BinaryPrimitives.ReadInt32LittleEndian(p.Slice(0x7C, 4)),
            DayProgressionMs= BinaryPrimitives.ReadInt32LittleEndian(p.Slice(0x80, 4)),
            PreRaceStartPos = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x84, 2)),
            NumCarsPreRace  = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x86, 2)),
            AlertMinRpm     = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x88, 2)),
            AlertMaxRpm     = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x8A, 2)),
            CalcMaxSpeedKph = BinaryPrimitives.ReadInt16LittleEndian(p.Slice(0x8C, 2)),
            Flags           = (SimulatorFlags)BinaryPrimitives.ReadUInt16LittleEndian(p.Slice(0x8E, 2)),
        };

        byte gears = p[0x90];
        pkt = pkt with
        {
            CurrentGear   = gears & 0x0F,
            SuggestedGear = (gears >> 4) & 0x0F,
            Throttle      = p[0x91],
            Brake         = p[0x92],

            WheelSpeedFL = ReadFloat(p, 0xB4),
            WheelSpeedFR = ReadFloat(p, 0xB8),
            WheelSpeedRL = ReadFloat(p, 0xBC),
            WheelSpeedRR = ReadFloat(p, 0xC0),

            TireRadiusFL = ReadFloat(p, 0xC4),
            TireRadiusFR = ReadFloat(p, 0xC8),
            TireRadiusRL = ReadFloat(p, 0xCC),
            TireRadiusRR = ReadFloat(p, 0xD0),

            SuspensionFL = ReadFloat(p, 0xD4),
            SuspensionFR = ReadFloat(p, 0xD8),
            SuspensionRL = ReadFloat(p, 0xDC),
            SuspensionRR = ReadFloat(p, 0xE0),

            ClutchPedal      = ReadFloat(p, 0xF4),
            ClutchEngagement = ReadFloat(p, 0xF8),
            RpmAfterClutch   = ReadFloat(p, 0xFC),
            TransmissionTopSpeedRatio = ReadFloat(p, 0x100),
            GearRatios = new[]
            {
                ReadFloat(p, 0x104),
                ReadFloat(p, 0x108),
                ReadFloat(p, 0x10C),
                ReadFloat(p, 0x110),
                ReadFloat(p, 0x114),
                ReadFloat(p, 0x118),
                ReadFloat(p, 0x11C),
                ReadFloat(p, 0x120),
            },
            CarCode = BinaryPrimitives.ReadInt32LittleEndian(p.Slice(0x124, 4)),
        };

        return pkt;
    }

    private static float ReadFloat(ReadOnlySpan<byte> b, int offset) =>
        BinaryPrimitives.ReadSingleLittleEndian(b.Slice(offset, 4));
}

/// <summary>Simulator flags as reported by GT7 in the packet (bit-field).</summary>
[Flags]
public enum SimulatorFlags : ushort
{
    None            = 0,
    CarOnTrack      = 1 << 0,
    Paused          = 1 << 1,
    LoadingOrProcessing = 1 << 2,
    InGear          = 1 << 3,
    HasTurbo        = 1 << 4,
    RevLimiter      = 1 << 5,
    HandBrakeActive = 1 << 6,
    LightsActive    = 1 << 7,
    HighBeamActive  = 1 << 8,
    LowBeamActive   = 1 << 9,
    AsmActive       = 1 << 10,
    TcsActive       = 1 << 11,
}
