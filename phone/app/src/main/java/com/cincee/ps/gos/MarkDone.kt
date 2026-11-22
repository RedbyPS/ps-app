package com.cincee.ps.gos

/**
 * PS 1.74: Mark done on a message from an AI (web core/aimessage.ts, the Mac's AiMessageCard.swift). An AI that sent the
 * message through the Mac's Task API with a task (and the "Tick tasks done" switch on) gets a card with markDone; here it is
 * one more button on that notification. A tap sends the card action "done" to the page, which checks again that the task
 * is still open, ticks it and dismisses the message on every device. Tapped while the page sleeps: kept, sent when it wakes.
 * Pure (MarkDoneTest); Notifier.kt adds the button, Receivers.kt sends or keeps the tap.
 */
object MarkDone {
    const val LABEL = "Mark done"
    const val ACTION = "done"
    /** Only a message from an AI ("c:msg-" cards), and only when the page said so. */
    fun shows(id: String, markDone: Boolean): Boolean = markDone && id.startsWith("c:msg-")
    /** Taps kept while the page sleeps: each card once, at most 20 (the newest). */
    fun keep(pending: Set<String>, id: String): Set<String> = (pending.filter { it != id } + id).takeLast(20).toSet()
}
