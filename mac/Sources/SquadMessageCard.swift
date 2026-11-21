// G Squad message card (PS 1.60, PR 10): its look and its buttons inside Toast's page. A message from someone in the squad
// comes as a card of tone "squad" (src/squad/chatengine.ts, core/squadnotify.ts): Open (brings the Tab list up on the chat),
// Reply (a box on the card, then Send with a short Undo) and Dismiss. Reply goes to the page as {type:"sqreply"} and the page
// sends it through the chat composer. Nothing is sent by itself: only the person's own Send, after the Undo ran out.
// Esc while typing closes the box (Toast.escape asks endEdit, which asks SquadMsg.esc). Reduced Motion: Toast's own rule.
// Words only: every text goes in with textContent, never as HTML. Everything the card page needs is here, so Toast.swift only
// carries a few one line hooks (like AiMessageCard.swift).
enum SquadMessageCard {
  static let tone = SquadMessageCore.tone
  static let icon = SquadMessageCore.icon

  /// Into Toast's page style sheet. A calm teal, so it reads as a chat message and not an email.
  static let css = #"""
  .t-squad{border-color:rgba(45,212,191,.55);background:linear-gradient(160deg,rgba(15,76,74,.96),rgba(12,22,26,.96) 60%)}
  .t-squad .ic{background:rgba(45,212,191,.24);color:#99F6E4}.t-squad .sub{color:#99F6E4}
  .t-squad .x{display:none}
  .t-squad .b{white-space:pre-line;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .t-squad .acts{margin-left:0;gap:5px}.t-squad .acts button{padding:7px 9px;font-size:12px;white-space:nowrap;flex:none}
  .t-squad .acts button.rep{background:rgba(45,212,191,.28);border:1px solid rgba(153,246,228,.45);color:#fff}.t-squad .acts button.rep:hover{background:rgba(45,212,191,.42)}
  .t-squad .acts button.dis{margin-left:auto}
  .t-squad .sqbox{margin-top:8px}
  .t-squad .sqbox textarea{display:block;width:100%;box-sizing:border-box;resize:none;height:54px;border-radius:12px;border:1px solid rgba(153,246,228,.4);padding:7px 9px;font:inherit;font-size:12.5px;line-height:1.4;color:#fff;background:rgba(255,255,255,.1);outline:none}
  .t-squad .sqbox textarea:focus{border-color:#99F6E4;box-shadow:0 0 0 2px rgba(45,212,191,.35)}
  .t-squad .sqbox .say{font-size:12px;color:#CCFBF1;margin:2px 0 0}
  .t-squad .sqbox .acts{margin-top:8px}
  .t-squad .sqbox button:disabled{opacity:.5}
  """#

  /// Into Toast's page script, inside its own scope (after the icons). SquadMsg.buttons draws the three buttons, .click answers
  /// true when it used the click, .focus and .esc are called by Toast's keyboard hooks, .gone when the card leaves.
  static let js = #"""
    ICON.chat='<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
    var SquadMsg={
      UNDO:5000,cur:null,
      // PS 1.73 (the developer, 21 Nov 2026: "I tried to click the reply button ... nothing happened, the reply button went away"): Toast
      // draws these buttons before it puts their row into the card, so the row had no parent yet and the Reply box had nowhere
      // to go (since 1.60). The box's place is now looked up when Reply is clicked (host), and the buttons only hide once the
      // box is really on the card.
      buttons:function(c,mb){
        [['main','Open','open'],['rep','Reply','reply'],['dis','Dismiss','dismiss']].forEach(function(x){var b=el('button',x[0],x[1]);b.dataset.sq=x[2];mb.appendChild(b)});
        c.sqActs=mb;
      },
      host:function(c){return c.sqActs&&c.sqActs.parentNode||null},
      click:function(c,t){
        var b=t.closest&&t.closest('button'),a=b&&b.dataset&&b.dataset.sq;
        if(!a)return !!(t.closest&&t.closest('.sqbox'));
        if(a==='open'){answer(c,'open');remove(c)}
        else if(a==='dismiss'){answer(c,'dismiss');remove(c)}
        else if(a==='reply')SquadMsg.show(c);
        else if(a==='send')SquadMsg.send(c);
        else if(a==='undo')SquadMsg.undo(c);
        else if(a==='cancel')SquadMsg.close(c);
        return true;
      },
      // The box: words, Send, Cancel. The keyboard comes to the panel for it (Swift, "typing").
      show:function(c){
        if(c.sqOpen||!SquadMsg.host(c))return;
        if(SquadMsg.cur&&SquadMsg.cur!==c)SquadMsg.close(SquadMsg.cur);
        c.sqOpen=true;SquadMsg.cur=c;
        SquadMsg.draw(c,'');
        c.sqActs.style.display='none';
        post({type:'typing',on:true});
        SquadMsg.focus();
      },
      draw:function(c,text){
        if(c.sqBox&&c.sqBox.parentNode)c.sqBox.parentNode.removeChild(c.sqBox);
        var box=el('div','sqbox'),ta=el('textarea');
        ta.value=text;ta.maxLength=2000;ta.placeholder='Reply to the squad';ta.setAttribute('aria-label','Reply to the squad');ta.spellcheck=true;
        ta.addEventListener('keydown',function(e){
          e.stopPropagation();
          if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();SquadMsg.send(c)}
          else if(e.key==='Escape'){e.preventDefault();SquadMsg.close(c)}
        });
        ta.addEventListener('pointerdown',function(e){e.stopPropagation()});
        ta.addEventListener('click',function(e){e.stopPropagation()});
        var row=el('div','acts'),s=el('button','main','Send'),x=el('button','dis','Cancel');
        s.dataset.sq='send';x.dataset.sq='cancel';row.appendChild(s);row.appendChild(x);
        box.appendChild(ta);box.appendChild(row);SquadMsg.host(c).appendChild(box);c.sqBox=box;c.sqTa=ta;c.sqUndo=false;
      },
      focus:function(){var c=SquadMsg.cur;if(c&&c.sqTa&&!c.sqUndo){c.sqTa.focus();var n=c.sqTa.value.length;try{c.sqTa.setSelectionRange(n,n)}catch(e){}}},
      // Send: nothing goes yet. A short Undo first; when it runs out the page gets the words.
      send:function(c){
        var text=c.sqTa&&c.sqTa.value.trim();if(!text||c.sqUndo)return;
        c.sqText=text;c.sqUndo=true;c.sqUntil=Date.now()+SquadMsg.UNDO;
        var box=el('div','sqbox'),say=el('div','say',''),row=el('div','acts'),u=el('button','main','Undo');
        u.dataset.sq='undo';row.appendChild(u);box.appendChild(say);box.appendChild(row);
        c.sqBox.parentNode.replaceChild(box,c.sqBox);c.sqBox=box;c.sqTa=null;
        var tick=function(){
          var left=c.sqUntil-Date.now();
          if(left<=0){SquadMsg.fire(c);return}
          say.textContent='Sending in '+Math.ceil(left/1000)+' s';
        };
        tick();c.sqTimer=setInterval(tick,250);
        post({type:'typing',on:false});
      },
      fire:function(c){
        clearInterval(c.sqTimer);c.sqTimer=0;c.sqFiring=true;
        var text=c.sqText;c.sqText='';c.sqUndo=false;c.sqOpen=false;c.sqKeep=false;if(SquadMsg.cur===c)SquadMsg.cur=null;
        if(text&&c.data.id)post({type:'sqreply',id:c.data.id,text:text});
        remove(c);
      },
      // The card is asked to leave (a swipe, another device read the chat, Clear all) while a Send waits for its Undo: the card
      // stays, with its Undo, until the Undo time is up. Toast's remove() asks first. True: it stays.
      hold:function(c){
        if(!c.sqUndo||!c.sqText||c.sqFiring)return false;
        c.sqKeep=true;c.dx=0;if(c.el&&c.el.classList)c.el.classList.remove('drag');layout();
        return true;
      },
      undo:function(c){
        if(!c.sqUndo)return;
        clearInterval(c.sqTimer);c.sqTimer=0;c.sqUndo=false;
        var text=c.sqText||'';c.sqText='';SquadMsg.draw(c,text);
        post({type:'typing',on:true});SquadMsg.focus();
      },
      // Cancel and Esc: the box closes, nothing is sent (not even during the Undo), the three buttons come back.
      close:function(c){
        if(!c.sqOpen)return;
        clearInterval(c.sqTimer);c.sqTimer=0;c.sqUndo=false;c.sqText='';c.sqOpen=false;
        if(c.sqBox&&c.sqBox.parentNode)c.sqBox.parentNode.removeChild(c.sqBox);c.sqBox=null;c.sqTa=null;
        if(c.sqActs)c.sqActs.style.display='';
        if(SquadMsg.cur===c)SquadMsg.cur=null;
        post({type:'typing',on:false});
        layout();
      },
      esc:function(){if(SquadMsg.cur)SquadMsg.close(SquadMsg.cur)},
      // The card is gone for good (it moved to the other stack, or nothing could keep it) while a Send waits for its Undo: it was
      // the person's own Send, so it still goes, but only when the Undo time is up, never early. Anything else just closes.
      gone:function(c){
        if(!c.sqOpen)return;
        if(c.sqUndo&&c.sqText&&c.data.id){
          var t=c.sqText,id=c.data.id;c.sqText='';
          setTimeout(function(){post({type:'sqreply',id:id,text:t})},Math.max(0,c.sqUntil-Date.now()));
        }
        clearInterval(c.sqTimer);c.sqTimer=0;c.sqUndo=false;c.sqOpen=false;c.sqKeep=false;if(SquadMsg.cur===c)SquadMsg.cur=null;
        post({type:'typing',on:false});
      }
    };
  """#
}
