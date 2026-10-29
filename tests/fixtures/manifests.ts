// Example manifests used by unit and integration tests.

export const HLS_MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p/index.m3u8?token=xyz
`;

export const HLS_MEDIA_TS_VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
seg-0.ts
#EXTINF:6.0,
seg-1.ts
#EXTINF:4.5,
seg-2.ts
#EXT-X-ENDLIST
`;

export const HLS_MEDIA_FMP4_LIVE = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
segment100.m4s
#EXTINF:4.0,
segment101.m4s
`;

export const HLS_AES128 = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1"
#EXTINF:6.0,
a.ts
#EXT-X-ENDLIST
`;

export const HLS_FAIRPLAY = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXTINF:6.0,
a.ts
#EXT-X-ENDLIST
`;

export const DASH_VOD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H2M3.5S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
      <Representation id="v1" bandwidth="800000" width="640" height="360"/>
      <Representation id="v2" bandwidth="5000000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

export const DASH_LIVE_WIDEVINE = `<MPD type="dynamic" availabilityStartTime="2020-01-01T00:00:00Z">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="3000000" width="1280" height="720" codecs="hev1.1.6.L93.B0"/>
    </AdaptationSet>
  </Period>
</MPD>`;
