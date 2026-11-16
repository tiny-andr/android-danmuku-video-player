package com.danmuku.bplayer.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AudioMediaTest {
  @Test fun nullCancellationEndsSessionButNotLiteralNullJob() {
    assertEquals("", AudioRequestArguments.cancelJob(JSONObject()))
    assertEquals("", AudioRequestArguments.cancelJob(JSONObject().put("jobId", JSONObject.NULL)))
    val job = "0f3ce2ca-1292-4b72-9845-0780d5dedc36"
    assertEquals(job, AudioRequestArguments.cancelJob(JSONObject().put("jobId", job)))
    assertThrows(IllegalArgumentException::class.java) { AudioRequestArguments.cancelJob(JSONObject().put("jobId", "null")) }
  }
  private fun probe(codec: String = "aac", channels: Int = 2, duration: Double = 120.0, tags: JSONObject = JSONObject()): JSONObject =
    JSONObject().put("streams", JSONArray().put(JSONObject().put("codec_type", "audio").put("codec_name", codec).put("channels", channels)))
      .put("format", JSONObject().put("duration", duration.toString()).put("tags", tags))

  @Test fun taggedCacheRequiresSourceTrackAndVersion() {
    val tags = AudioMedia.tags("source", 2, 0.125)
    assertEquals(false to 0.125, AudioMedia.validCache(probe(tags = tags), "source", 2, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(tags = tags), "changed", 2, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(tags = tags), "source", 1, 120.0, 10, 20))
    tags.put("bplayer_version", "other")
    assertNull(AudioMedia.validCache(probe(tags = tags), "source", 2, 120.0, 10, 20))
  }
  @Test fun matroskaUppercaseTagsAreNormalized() {
    val tags = JSONObject().put("BPLAYER_VERSION", "1").put("BPLAYER_SOURCE", "source")
      .put("BPLAYER_TRACK", "0").put("BPLAYER_OFFSET", "-1.5")
    assertEquals(false to -1.5, AudioMedia.validCache(probe(tags = tags), "source", 0, 120.0, null, null))
  }
  @Test fun corruptedOrUnexpectedStreamsCannotBecomeCacheHits() {
    val tags = AudioMedia.tags("source", 0, 0.0)
    assertNull(AudioMedia.validCache(probe("dts", tags = tags), "source", 0, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(channels = 8, tags = tags), "source", 0, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(duration = 200.0, tags = tags), "source", 0, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(duration = 5.0, tags = tags), "source", 0, 120.0, 10, 20))
    assertEquals(false to 0.0, AudioMedia.validCache(probe(duration = 5.0, tags = tags), "source", 0, 120.0, 10, 20, false))
    val extra = probe(tags = tags); extra.getJSONArray("streams").put(JSONObject().put("codec_type", "video"))
    assertNull(AudioMedia.validCache(extra, "source", 0, 120.0, 10, 20))
  }
  @Test fun legacyCacheNeedsKnownFreshModificationAndFullDuration() {
    assertEquals(true to 0.0, AudioMedia.validCache(probe(), "source", 0, 120.0, 10, 20))
    assertNull(AudioMedia.validCache(probe(), "source", 0, 120.0, 30, 20))
    assertNull(AudioMedia.validCache(probe(), "source", 0, 120.0, null, 20))
    assertNull(AudioMedia.validCache(probe(), "source", 0, null, 10, 20))
    assertNull(AudioMedia.validCache(probe(duration = 5.0), "source", 0, 120.0, 10, 20))
  }
  @Test fun offsetRejectsInvalidCachedValues() {
    val tags = AudioMedia.tags("source", 0, 0.0).put("bplayer_offset", "NaN")
    assertNull(AudioMedia.validCache(probe(tags = tags), "source", 0, 120.0, 10, 20))
    tags.put("bplayer_offset", "3601")
    assertNull(AudioMedia.validCache(probe(tags = tags), "source", 0, 120.0, 10, 20))
  }
  @Test fun selectedTrackOffsetUsesContainerTimeline() {
    val source = probe().apply {
      getJSONObject("format").put("start_time", "-0.1")
      getJSONArray("streams").getJSONObject(0).put("start_time", "0.25")
    }
    assertEquals(0.35, AudioMedia.offset(source, 0), 0.0001)
  }
  @Test fun codecsAndDefaultDispositionFollowAudioTrackOrder() {
    assertEquals("A_DTS", AudioMedia.codec("dts")); assertEquals("A_PCM/BLURAY", AudioMedia.codec("pcm_bluray"))
    assertEquals("A_EAC3", AudioMedia.codec("eac3"))
    val source = probe().apply {
      getJSONArray("streams").getJSONObject(0).put("index", 4).put("disposition", JSONObject().put("default", 1))
        .put("tags", JSONObject().put("language", "zho"))
    }
    val track = AudioMedia.normalized(source).getJSONArray("tracks").getJSONObject(0)
    assertTrue(track.getBoolean("default")); assertEquals(5, track.getInt("number")); assertEquals("zho", track.getString("lang"))
    assertEquals(120000000L, AudioMedia.normalized(source).getLong("duration_us"))
  }
}
