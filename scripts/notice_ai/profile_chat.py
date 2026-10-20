"""Ground profile writes in the current user's own words, never retrieved text."""

import re

from .schema import AIError


DEGREE_WORDS = {
    "undergraduate": r"本科(?:生)?", "master": r"硕士(?:研究生)?", "doctor": r"博士(?:研究生)?",
    "postgraduate": r"研究生", "staff": r"教职工|教师|老师|职工", "other": r"其他身份",
}
FACTS = {"degree", "admissionYear", "college", "major"}


def direct_profile_intent(text):
    if not isinstance(text, str):
        return False
    # An example, quote, hypothetical or question about someone else cannot
    # grant a tool permission to turn that person's facts into the user's.
    if re.search(r"[‘’“”\"「」『』]|(?:^|\n)\s*>|```|假设|假如|举例|例如|比如|通知[里中]?说|原文|他(?:说|的)|她(?:说|的)", text):
        return False
    return bool(re.search(r"我(?:是|就读|在读|在|的(?:学号|学历|学院|专业|入学|兴趣)|喜欢|关注|对|希望|想看|不想|不希望)|(?:请|帮我)?记住|(?:更新|修改|清空|删除|忘记).{0,8}(?:画像|偏好|兴趣)", text))


def local_student_number(text):
    if not direct_profile_intent(text):
        return None
    match = re.fullmatch(r"\s*(?:我(?:的)?)?学号(?:是|为|[:：=])\s*(3\d{7,12})\s*[。.!！]?\s*", text)
    return match.group(1) if match else None


def redact_student_number(text):
    return re.sub(r"(?<!\d)3\d{7,12}(?!\d)", "[学号已脱敏]", text)


def grounded_patch(args, user_text):
    if (not isinstance(args, dict) or set(args) != {"updates"}
            or not isinstance(args["updates"], list) or not 1 <= len(args["updates"]) <= 8
            or not direct_profile_intent(user_text)):
        raise AIError("profile_statement_required", 400)
    facts, changes = {}, []
    for update in args["updates"]:
        if (not isinstance(update, dict) or set(update) != {"field", "value", "evidence", "mode"}
                or not isinstance(update["evidence"], str) or not update["evidence"].strip()
                or len(update["evidence"]) > 400 or update["evidence"] not in user_text):
            raise AIError("profile_statement_required", 400)
        field, value, evidence, mode = (update[key] for key in ("field", "value", "evidence", "mode"))
        if not direct_profile_intent(evidence) or re.search(r"[?？]|是不是|是否|可能|也许|假如|如果", evidence):
            raise AIError("profile_statement_required", 400)
        if field in FACTS:
            if mode != "set":
                raise AIError("profile_invalid", 400)
            if re.search(r"不是|并非|以前|曾经|不再|不属于", evidence):
                raise AIError("profile_statement_required", 400)
            if field == "degree":
                if not isinstance(value, str) or value not in DEGREE_WORDS or not re.search(DEGREE_WORDS[value], evidence):
                    raise AIError("profile_statement_required", 400)
                if value == "postgraduate" and re.search(r"硕士|博士", evidence):
                    raise AIError("profile_statement_required", 400)
                # Do not reinterpret a former/negated identity as the current one.
                if re.search(r"不是|并非|以前|曾经|毕业|不再", evidence):
                    raise AIError("profile_statement_required", 400)
            elif field == "admissionYear":
                if type(value) is not int or not re.search(rf"{value}\s*(?:级|年入学|年.{{0,4}}入学)", evidence):
                    raise AIError("profile_statement_required", 400)
            elif not isinstance(value, str) or not value.strip() or value not in evidence:
                raise AIError("profile_statement_required", 400)
            facts[field] = {"value": value, "confirmed": True}
        elif field in {"interests", "avoid"}:
            if mode not in {"add", "remove"} or not isinstance(value, str) or not value.strip() or value not in evidence:
                raise AIError("profile_statement_required", 400)
            if field == "avoid" and mode == "add" and not re.search(r"不想|不希望|不要|不喜欢|不感兴趣|暂不|少看|少推", evidence):
                raise AIError("profile_statement_required", 400)
            if field == "interests" and mode == "add" and re.search(r"不想|不希望|不要|不喜欢|不感兴趣", evidence):
                raise AIError("profile_statement_required", 400)
            if mode == "remove" and not re.search(r"移除|忘记|删|去掉|不再|别记|不要记|取消", evidence):
                raise AIError("profile_statement_required", 400)
            changes.append((field, value.strip(), mode))
        else:
            raise AIError("profile_invalid", 400)
    return facts, changes


def apply_chat_update(store, args, user_text, *, expected_version=None):
    facts, changes = grounded_patch(args, user_text)
    before = store.snapshot()
    preferences = {key: list(before["preferences"][key]) for key in ("interests", "avoid")}
    for field, value, mode in changes:
        preferences[field] = [item for item in preferences[field] if item != value]
        if mode == "add":
            preferences[field].append(value)
    patch = {"expectedVersion": before["version"] if expected_version is None else expected_version}
    if facts:
        patch["facts"] = facts
    if changes:
        patch["preferences"] = preferences
    return store.update(patch, source="chat")
