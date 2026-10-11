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
    return getkey(out(d, "Dictionary"), "text")
def exec_params(cmd_parts):
    return ['{"jsonrpc":"2.0","id":2,"method":"call","params":["', ("var", "Session"),
            '","file","exec",{"command":"/usr/libexec/nft-limiter-switch","params":['] + cmd_parts + [']}]}']
def cond(mode, grp, extra=None):
    p = {"WFControlFlowMode": mode, "GroupingIdentifier": grp}
    if extra: p.update(extra)
    act("is.workflow.actions.conditional", p)

# 1. log in, keep the session id
t = text(['{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"' + USER + '","password":"' + PW + '"}]}'])
r = post(t)
res = getkey(out(r, "Contents of URL"), "result")
it = U(); act("is.workflow.actions.getitemfromlist", {"WFInput": out(res, "Dictionary Value"), "WFItemSpecifier": "Item At Index", "WFItemIndex": 2}, it)
sid = getkey(out(it, "Item from List"), "ubus_rpc_session")
setvar("Session", out(sid, "Dictionary Value"))
# 2. status
t = text(exec_params(['"status","' + SW + '"']))
st = result_stdout(post(t))
setvar("Status", out(st, "Dictionary Value"))
# 3. which toggle to offer
g = U()
cond(0, g, {"WFCondition": 99, "WFConditionalActionString": "is not blocked", "WFInput": {"Type": "Variable", "Variable": var("Status")}})
setvar("Toggle", out(text(["Turn block on"]), "Text"))
setvar("ToggleCmd", out(text(['"on"']), "Text"))
cond(1, g)
setvar("Toggle", out(text(["Turn block off"]), "Text"))
setvar("ToggleCmd", out(text(['"off"']), "Text"))
cond(2, g)
# 4. choose: the toggle or change hours
lst = U(); act("is.workflow.actions.list", {"WFItems": [tstr([("var", "Toggle")]), "Change hours"]}, lst)
ch = U(); act("is.workflow.actions.choosefromlist", {"WFInput": out(lst, "List"), "WFChooseFromListActionPrompt": tstr([("var", "Status")])}, ch)
setvar("Choice", out(ch, "Chosen Item"))
g2 = U()
cond(0, g2, {"WFCondition": 4, "WFConditionalActionString": "Change hours", "WFInput": {"Type": "Variable", "Variable": var("Choice")}})
m = U()
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 0, "GroupingIdentifier": m, "WFMenuPrompt": "Block hours", "WFMenuItems": ["Set times", "All day"]})
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 1, "GroupingIdentifier": m, "WFMenuItemTitle": "Set times"})
a1 = U(); act("is.workflow.actions.ask", {"WFInputType": "Time", "WFAskActionPrompt": "Block from"}, a1)
f1 = U(); act("is.workflow.actions.format.date", {"WFDateFormatStyle": "Custom", "WFDateFormat": "HH:mm", "WFDate": tstr([("out", a1, "Provided Input")])}, f1)
setvar("From", out(f1, "Formatted Date"))
a2 = U(); act("is.workflow.actions.ask", {"WFInputType": "Time", "WFAskActionPrompt": "Block until"}, a2)
f2 = U(); act("is.workflow.actions.format.date", {"WFDateFormatStyle": "Custom", "WFDateFormat": "HH:mm", "WFDate": tstr([("out", a2, "Provided Input")])}, f2)
setvar("To", out(f2, "Formatted Date"))
setvar("Cmd", out(text(['"hours","' + SW + '","', ("var", "From"), '","', ("var", "To"), '"']), "Text"))
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 1, "GroupingIdentifier": m, "WFMenuItemTitle": "All day"})
setvar("Cmd", out(text(['"hours","' + SW + '","allday"']), "Text"))
act("is.workflow.actions.choosefrommenu", {"WFControlFlowMode": 2, "GroupingIdentifier": m})
cond(1, g2)
setvar("Cmd", out(text([("var", "ToggleCmd"), ',"' + SW + '"']), "Text"))
cond(2, g2)
# 5. run it and show what the router now says
t = text(exec_params([("var", "Cmd")]))
done = result_stdout(post(t))
act("is.workflow.actions.notification", {"WFNotificationActionTitle": TITLE, "WFNotificationActionBody": tstr([("out", done, "Dictionary Value")])})

wf = {"WFWorkflowActions": actions, "WFWorkflowClientVersion": "2302.0.4", "WFWorkflowMinimumClientVersion": 900,
      "WFWorkflowMinimumClientVersionString": "900", "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
      "WFWorkflowImportQuestions": [], "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": [],
      "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False}
plistlib.dump(wf, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("actions:", len(actions))
