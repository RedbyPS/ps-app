// A message from an AI (V1.58, the developer 13 Nov 2026: "I want the AI to write to me at the end of each chat instead of the AI
// completion cards, because it just says the AI chat is complete"). An AI on this Mac sends POST /v1/island/message
// through the Task API (switch "message", off unless switched on; web core/aimessage.ts has the rules). The
// page keeps it in the encrypted settings and sends it here as a card of its own, tone "ai", on the same path as the AI
// chat finished cards (src/mailcards.ts): its id starts with "c:", so Do Not Disturb (DND.kind), where it comes out
// (NoteDrop.kind: the island, or the top right) and the sounds all treat it as an AI chat card.
// The card: who it is from, the message, and the longer detail folded to three lines; a click opens the rest (and a
// second click folds it again). Private mode makes it the usual pill until clicked (Toast's page does that for every
// card). Words only: the page puts every text in with textContent, never as HTML.
// PS 1.74 (Jan, 21 Nov 2026): a message tied to a task (POST /v1/island/message with "task") comes with markDone, and the card
// then has a Mark done button first in its row. Its click sends the action "done"; the page ticks the task only if it still
// may (the "Tick tasks done" switch on, the task open: web core/aimessage.ts markDoneOk) and then dismisses the message.
// Everything the card page needs for it is here, so Toast.swift only carries a few one line hooks.
enum AiMessageCard {
  static let tone = "ai"
  /// The longest detail a card carries (core/aimessage.ts AI_MSG.detailMax).
  static let detailMax = 2000
  static let icon = "ai"
  /// The Mark done button's words and the action it sends (web core/aimessage.ts AI_MSG_DONE).
  static let doneLabel = "Mark done", doneAction = "done"
  /// Only a message card says it has a Mark done (Toast.showMeet): anything else sent with markDone is ignored.
  static func markDone(tone: String, _ v: Any?) -> Bool { tone == Self.tone && (v as? Bool) == true }

  /// Into Toast's page style sheet. Colours like the AI chat finished cards, a little bluer, so it reads as a message.
  static let css = #"""
  .t-ai{border-color:rgba(140,160,255,.55);background:linear-gradient(160deg,rgba(38,40,96,.96),rgba(18,17,30,.96) 60%)}
  .t-ai .ic{background:rgba(140,160,255,.24);color:#C4CEFF}.t-ai .sub{color:#E8ECFF;font-weight:600;white-space:normal}
  .t-ai .b{white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
  .t-ai.open .b{display:block;-webkit-line-clamp:unset;overflow:visible}
  .t-ai .more{display:block;margin-top:4px;font-size:11.5px;font-weight:650;color:#AFC0FF;cursor:pointer}
  .t-ai .x{display:none}
  .t-ai .acts{margin-left:0;gap:5px}.t-ai .acts button{padding:7px 9px;font-size:12px;white-space:nowrap;flex:none}
  .t-ai .acts button.done{background:rgba(196,206,255,.92);color:#17183A}.t-ai .acts button.done:hover{background:#fff}
  .t-ai .acts button.rem{background:rgba(140,160,255,.3);border-color:rgba(196,206,255,.45)}.t-ai .acts button.rem:hover{background:rgba(140,160,255,.44)}
  .t-ai .life i{background:#C4CEFF}
  """#

  /// Into Toast's page script, inside its own scope (after the icons): the icon and what a click on the card does.
  /// AiMsg.click answers true when it used the click (the detail opened or folded).
  static let js = #"""
    ICON.ai='<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>';
    var AiMsg={
      // A card was made (Toast's add): once it is on the page, a detail longer than three lines gets "Read more" under it.
      made:function(c){
        requestAnimationFrame(function(){
          var b=c.inner&&c.inner.querySelector('.b');if(!b||c.aiMore||b.scrollHeight<=b.clientHeight+2)return;
          c.aiMore=document.createElement('span');c.aiMore.className='more';b.parentNode.insertBefore(c.aiMore,b.nextSibling);AiMsg.say(c);
        });
      },
      // PS 1.74: Mark done, first in the buttons row, when the page said the message's task may be ticked.
      buttons:function(c,mb){
        if(!c.data||c.data.markDone!==true)return;
        var b=document.createElement('button');b.className='main done';b.textContent='Mark done';b.dataset.act='done';mb.appendChild(b);
      },
      say:function(c){if(c.aiMore)c.aiMore.textContent=c.el.classList.contains('open')?'Show less':'Read more'},
      // A click on the words opens the whole detail, and folds it again. Buttons keep their own jobs.
      click:function(c,t){
        if(!c.aiMore||(t.closest&&(t.closest('button')||t.closest('.rv')||t.closest('.acts'))))return false;
        c.el.classList.toggle('open');AiMsg.say(c);return true;
      }
    };
  """#
}
