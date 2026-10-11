#!/usr/bin/env python3
"""Build an iOS/macOS Shortcut that drives one nft-limiter family switch.

The Shortcut logs in to the router's JSON-RPC endpoint (/ubus) as a limited
rpcd login (see README, "Family switches"), reads the switch's status, offers
"Turn block on/off" or "Change hours" (set times or all day), runs the choice
through /usr/libexec/nft-limiter-switch and shows the router's answer.

Usage:
  contrib/make-shortcut.py --url http://192.0.2.1/ubus --switch phone \
      --password-file pw.txt --title "Phone" --out "Phone.unsigned.shortcut"
  shortcuts sign --mode people-who-know-me \
      --input "Phone.unsigned.shortcut" --output "Phone.shortcut"

The password is stored in the Shortcut in plain text: give the login nothing
but the switch ACL. "--mode anyone" signing needs Apple's servers and can
time out; "people-who-know-me" signs with the Mac's iCloud identity.
"""
import argparse, plistlib, uuid
ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True, help="router JSON-RPC URL, e.g. http://192.0.2.1/ubus")
ap.add_argument("--switch", required=True, help="the rule's switch name (switch_id)")
ap.add_argument("--user", default="family", help="rpcd login (default: family)")
ap.add_argument("--password-file", required=True)
ap.add_argument("--title", default="Family switch", help="notification title")
ap.add_argument("--out", required=True)
a = ap.parse_args()
URL, SW, USER, TITLE, OUT = a.url, a.switch, a.user, a.title, a.out
PW = open(a.password_file).read().strip()
actions = []
def U(): return str(uuid.uuid4()).upper()
def act(ident, params, uid=None):
    p = dict(params)
    if uid: p["UUID"] = uid
    actions.append({"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p})
    return uid
def out(uid, name): return {"Value": {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name}, "WFSerializationType": "WFTextTokenAttachment"}
def var(name): return {"Value": {"Type": "Variable", "VariableName": name}, "WFSerializationType": "WFTextTokenAttachment"}
def tstr(parts):
    """Token string from a list of str / ('var', name) / ('out', uid, name)."""
    s, att = "", {}
    for p in parts:
        if isinstance(p, str): s += p
        else:
            ref = {"Type": "Variable", "VariableName": p[1]} if p[0] == "var" else {"Type": "ActionOutput", "OutputUUID": p[1], "OutputName": p[2]}
            att["{%d, 1}" % len(s)] = ref; s += "￼"
    return {"Value": {"string": s, "attachmentsByRange": att}, "WFSerializationType": "WFTextTokenString"}
def text(parts):
    uid = U(); act("is.workflow.actions.gettext", {"WFTextActionText": tstr(parts)}, uid); return uid
def post(body_uid):
    uid = U(); act("is.workflow.actions.downloadurl", {"WFURL": URL, "WFHTTPMethod": "POST", "WFHTTPBodyType": "File", "WFRequestVariable": out(body_uid, "Text")}, uid); return uid
def getkey(inp, key, name="Dictionary Value"):
    uid = U(); act("is.workflow.actions.getvalueforkey", {"WFInput": inp, "WFDictionaryKey": key, "WFGetDictionaryValueType": "Value"}, uid); return uid
def setvar(name, inp): act("is.workflow.actions.setvariable", {"WFVariableName": name, "WFInput": inp})
def result_stdout(resp_uid):
    r = getkey(out(resp_uid, "Contents of URL"), "result")
    it = U(); act("is.workflow.actions.getitemfromlist", {"WFInput": out(r, "Dictionary Value"), "WFItemSpecifier": "Item At Index", "WFItemIndex": 2}, it)
    so = getkey(out(it, "Item from List"), "stdout")
    d = U(); act("is.workflow.actions.detect.dictionary", {"WFInput": out(so, "Dictionary Value")}, d)
    return d, getkey(out(d, "Dictionary"), "text")
def exec_params(cmd_parts):
    return ['{"jsonrpc":"2.0","id":2,"method":"call","params":["', ("var", "Session"),
            '","file","exec",{"command":"/usr/libexec/nft-limiter-switch","params":['] + cmd_parts + [']}]}']
def cond(mode, grp, test=None):
    """If/Otherwise/End If. test = (condition code, variable name, text):
    4 is, 99 contains. The variable must hold Text: Shortcuts types a
    variable by the action that set it, and an If on a Dictionary Value
    offers no text operand ("Please choose a value for each parameter")."""
    p = {"WFControlFlowMode": mode, "GroupingIdentifier": grp}
    if test:
        code, name, s = test
        p.update({"WFCondition": code, "WFConditionalActionString": s,
                  "WFInput": {"Type": "Variable", "Variable": var(name)}})
    act("is.workflow.actions.conditional", p)
def ask_time(prompt, default, name):
    """Ask for a time, starting at variable default ("HH:MM", from the
    status), and set variable name to it as "HH:MM". A Time picker reads
    its start only from WFAskActionDefaultAnswerTime holding a Date (a Date
    action's output); text, or the DateAndTime/Date keys, are ignored and
    it starts at the current time. A custom "HH:mm" format follows the
    device's 12/24-hour setting on iOS (8 PM came out "08:00"), so the
    time goes out as ISO 8601 and the HH:MM before the seconds is cut
    from that."""
    d = U(); act("is.workflow.actions.date", {"WFDateActionMode": "Specified Date",
        "WFDateActionDate": tstr([("var", default)])}, d)
    a = U(); act("is.workflow.actions.ask", {"WFInputType": "Time", "WFAskActionPrompt": prompt,
        "WFAskActionDefaultAnswerTime": tstr([("out", d, "Date")])}, a)
    f = U(); act("is.workflow.actions.format.date", {"WFDateFormatStyle": "ISO 8601", "WFISO8601IncludeTime": True,
        "WFDate": tstr([("out", a, "Provided Input")])}, f)
    mt = U(); act("is.workflow.actions.text.match", {"WFMatchTextPattern": r"[0-9]{2}:[0-9]{2}(?=:)",
        "text": tstr([("out", f, "Formatted Date")])}, mt)
    g = U(); act("is.workflow.actions.getitemfromlist", {"WFInput": out(mt, "Matches"), "WFItemSpecifier": "First Item"}, g)
    setvar(name, out(text([("out", g, "Item from List")]), "Text"))
def item(parts): return {"WFItemType": 0, "WFValue": tstr(parts)}

# 1. log in, keep the session id
t = text(['{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"' + USER + '","password":"' + PW + '"}]}'])
r = post(t)
res = getkey(out(r, "Contents of URL"), "result")
it = U(); act("is.workflow.actions.getitemfromlist", {"WFInput": out(res, "Dictionary Value"), "WFItemSpecifier": "Item At Index", "WFItemIndex": 2}, it)
sid = getkey(out(it, "Item from List"), "ubus_rpc_session")
setvar("Session", out(sid, "Dictionary Value"))
# 2. status
t = text(exec_params(['"status","' + SW + '"']))
sd, st = result_stdout(post(t))
setvar("Status", out(text([("out", st, "Dictionary Value")]), "Text"))
# the rule's current hours, where the time pickers start
for key, name in (("from", "CurFrom"), ("to", "CurTo")):
    v = getkey(out(sd, "Dictionary"), key)
    setvar(name, out(text([("out", v, "Dictionary Value")]), "Text"))
# 3. which toggle to offer
g = U()
cond(0, g, (99, "Status", "is not blocked"))
setvar("Toggle", out(text(["Turn block on"]), "Text"))
setvar("ToggleCmd", out(text(['"on"']), "Text"))
cond(1, g)
setvar("Toggle", out(text(["Turn block off"]), "Text"))
setvar("ToggleCmd", out(text(['"off"']), "Text"))
cond(2, g)
# 4. choose: the toggle or change hours
lst = U(); act("is.workflow.actions.list", {"WFItems": [item([("var", "Toggle")]), item(["Change hours"])]}, lst)
ch = U(); act("is.workflow.actions.choosefromlist", {"WFInput": out(lst, "List"), "WFChooseFromListActionPrompt": tstr([("var", "Status")])}, ch)
setvar("Choice", out(ch, "Chosen Item"))
g2 = U()
cond(0, g2, (4, "Choice", "Change hours"))
m = U()
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 0, "GroupingIdentifier": m, "WFMenuPrompt": "Block hours", "WFMenuItems": ["Set times", "All day"]})
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 1, "GroupingIdentifier": m, "WFMenuItemTitle": "Set times"})
ask_time("Block from", "CurFrom", "From")
ask_time("Block until", "CurTo", "To")
setvar("Cmd", out(text(['"hours","' + SW + '","', ("var", "From"), '","', ("var", "To"), '"']), "Text"))
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 1, "GroupingIdentifier": m, "WFMenuItemTitle": "All day"})
setvar("Cmd", out(text(['"hours","' + SW + '","allday"']), "Text"))
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 2, "GroupingIdentifier": m})
cond(1, g2)
setvar("Cmd", out(text([("var", "ToggleCmd"), ',"' + SW + '"']), "Text"))
cond(2, g2)
# 5. run it and show what the router now says
t = text(exec_params([("var", "Cmd")]))
_, done = result_stdout(post(t))
act("is.workflow.actions.notification", {"WFNotificationActionTitle": TITLE, "WFNotificationActionBody": tstr([("out", done, "Dictionary Value")])})

wf = {"WFWorkflowActions": actions, "WFWorkflowClientVersion": "2302.0.4", "WFWorkflowMinimumClientVersion": 900,
      "WFWorkflowMinimumClientVersionString": "900", "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
      "WFWorkflowImportQuestions": [], "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": [],
      "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False}
plistlib.dump(wf, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("actions:", len(actions))
