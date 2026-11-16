package com.danmuku.bplayer.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AudioWorkerValidationTest {
  @Test fun retirementDoesNotReleaseBeforeNativeExit() {
    val state = AudioWorkerLifecycle()
    assertTrue(state.running); assertFalse(state.release())
    assertTrue(state.finish(true)); assertTrue(state.retiring); assertFalse(state.running)
    assertFalse(state.finish(true)); assertTrue(state.release()); assertTrue(state.released)
    assertFalse(state.release()); assertFalse(state.finish(false))
  }
  @Test fun finishedNativeCallCanReleaseImmediately() {
    val state = AudioWorkerLifecycle()
    assertTrue(state.finish(false)); assertFalse(state.retiring); assertTrue(state.release())
  }
  @Test fun sizeSentinelCannotBecomeSuccessfulOutput() {
    assertFalse(AudioWorkerValidation.outputSize(0)); assertTrue(AudioWorkerValidation.outputSize(1))
    assertTrue(AudioWorkerValidation.outputSize(AudioWorkerValidation.MAX_AUDIO_BYTES))
    assertFalse(AudioWorkerValidation.outputSize(AudioWorkerValidation.MAX_AUDIO_BYTES + 1))
    assertFalse(AudioWorkerValidation.outputSize(AudioWorkerValidation.OUTPUT_SENTINEL_BYTES))
  }
  @Test fun metadataAllowsOnlyBoundedApplicationTags() {
    val args = AudioWorkerValidation.metadata("{\"bplayer_source\":\"source hash\"}")
    assertEquals(listOf("-metadata", "bplayer_source=source hash"), args)
    assertThrows(IllegalArgumentException::class.java) { AudioWorkerValidation.metadata("{\"anything\":\"value\"}") }
    assertThrows(IllegalArgumentException::class.java) { AudioWorkerValidation.metadata(JSONObject().put("bplayer_tag", "x".repeat(1025)).toString()) }
  }
  @Test fun nativeInputAcceptsOnlyTokenizedLoopbackOrAllowedFiles() {
    assertEquals("http://127.0.0.1:1234/abcdefghijklmnop/encoded_path", AudioWorkerValidation.input("http://127.0.0.1:1234/abcdefghijklmnop/encoded_path"))
    for (value in listOf("http://example.com:1234/abcdefghijklmnop/path", "http://127.0.0.1:1234/a/b", "http://127.0.0.1:1234/abcdefghijklmnop/path?query=1", "/system/build.prop")) {
      assertThrows(IllegalArgumentException::class.java) { AudioWorkerValidation.input(value) }
    }
  }
  @Test fun durationUsesAudioOrdinalNotOverallStreamIndex() {
    val probe = JSONObject().put("streams", JSONArray().put(JSONObject().put("codec_type", "video"))
      .put(JSONObject().put("codec_type", "audio").put("duration", "9.5")))
    assertEquals(9.5, AudioWorkerValidation.duration(probe, 0)!!, 0.00001)
    assertThrows(IllegalArgumentException::class.java) { AudioWorkerValidation.duration(probe, 1) }
  }
  @Test fun shortAudioIsAllowedOnlyWhenExactSourceDurationUnknown() {
    val output = JSONObject().put("streams", JSONArray().put(JSONObject().put("codec_type", "audio").put("codec_name", "aac").put("channels", 2)))
      .put("format", JSONObject().put("duration", "5"))
    assertTrue(AudioWorkerValidation.output(output, null, 120.0))
    assertFalse(AudioWorkerValidation.output(output, 120.0, 120.0))
  }
}
