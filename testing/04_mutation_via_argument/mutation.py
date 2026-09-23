def collect_bonus(user: dict, bonus_list: list) -> list:
    add_bonus(bonus_list, user["bonus"])
    return bonus_list


def add_bonus(bonus_list: list, amount: float) -> None:
    bonus_list.append(amount)
