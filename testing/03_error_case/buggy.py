def grade_score(score: int) -> str:
    if score >= 90:
        grade = "A"
    elif score >= 80:
        grade = "B"
    elif score >= 70:
        grade = "C"
    # Bug: score < 70 never assigns grade
    # NameError at runtime if score is below 70
    return grade


def safe_divide(values: list, divisor: int) -> list:
    results = []
    for value in values:
        if divisor == 0:
            raise ValueError("Cannot divide by zero")
        result = value / divisor
        results.append(result)
    return results


def process_user_input(data: dict) -> str:
    user = data.get("user")
    # Bug: user could be None, but we call .upper() unconditionally
    name = user["name"].upper()
    role = data.get("role", "guest")

    if role == "admin":
        return f"Welcome admin {name}"
    elif role == "user":
        return f"Hello {name}"
    else:
        return f"Access denied for {name}"
