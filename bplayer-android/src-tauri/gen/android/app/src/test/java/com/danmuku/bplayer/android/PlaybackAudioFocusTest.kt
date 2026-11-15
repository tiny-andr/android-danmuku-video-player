package com.danmuku.bplayer.android

import org.junit.Assert.*
import org.junit.Test

class PlaybackAudioFocusTest {
  @Test fun foregroundSessionIsReusedUntilExplicitAbandon() {
    val state = PlaybackSessionState()
    val first = state.begin()!!
    assertEquals(first, state.begin())
    assertEquals(first, state.active())
    assertEquals(first, state.abandon())
    assertNull(state.active())
    val second = state.begin()!!
    assertNotEquals(first, second)
  }

  @Test fun backgroundDeniesPermissionWithoutStartingSession() {
    val state = PlaybackSessionState()
    state.background()
    assertNull(state.begin())
    assertNull(state.active())
    state.foreground(true)
    assertNotNull(state.begin())
  }

  @Test fun explicitAbandonInvalidatesAllOlderSessionEvents() {
    val state = PlaybackSessionState()
    val session = state.begin()!!
    state.abandon()
    assertNull(state.active())
    assertFalse(state.valid(session))
    assertFalse(state.interrupt(session))
  }

  @Test fun noisyDisconnectInterruptsOnlyOnceAndNeverRestartsSession() {
    val state = PlaybackSessionState()
    val session = state.begin()!!
    assertTrue(state.interrupt(session))
    assertTrue(state.valid(session))
    assertFalse(state.interrupt(session))
    assertNull(state.active())
    state.foreground(true)
    assertNull(state.active())
  }

  @Test fun queuedOldDisconnectCannotPauseNewSession() {
    val state = PlaybackSessionState()
    val old = state.begin()!!
    state.interrupt(old)
    val next = state.begin()!!
    assertFalse(state.interrupt(old))
    assertFalse(state.valid(old))
    assertTrue(state.valid(next))
    assertEquals(next, state.active())
  }

  @Test fun foregroundReturnDoesNotResumeAndNewRequestInvalidatesBackgroundEvent() {
    val state = PlaybackSessionState()
    val session = state.begin()!!
    val event = state.background()
    assertFalse(state.valid(session))
    assertTrue(state.valid(event))
    assertNull(state.begin())
    state.foreground(true)
    assertNull(state.active())
    val next = state.begin()!!
    assertFalse(state.valid(event))
    assertTrue(state.valid(next))
  }

  @Test fun chromiumPauseEndsNativeSessionWithoutRequestingAnyNewOwnership() {
    val state = PlaybackSessionState()
    val first = state.begin()!!
    assertEquals(first, state.abandon())
    assertNull(state.abandon())
    assertNull(state.active())
    assertFalse(state.valid(first))
    val next = state.begin()!!
    assertNotEquals(first, next)
  }

  @Test fun destroyInvalidatesCallbacksAndAllLaterRequests() {
    val state = PlaybackSessionState()
    val session = state.begin()!!
    state.close()
    assertNull(state.begin())
    assertFalse(state.valid(session))
    assertFalse(state.interrupt(session))
    state.foreground(true)
    assertNull(state.begin())
  }
}
