from shapes import Circle


class Base:
    def __init__(self, value):
        self.value = value

    def base_method(self):
        return self.value * 2


class Derived(Base):
    # First param renamed from "self" — proves self/cls detection is positional,
    # not name-based.
    def derived_method(this):
        return this.base_method() + 1


# ─── Diamond multiple inheritance (real C3 MRO) ──────────────────────────────

class Left(Base):
    def base_method(self):
        return self.value + 100


class Right(Base):
    def base_method(self):
        return self.value + 200


class Diamond(Left, Right):
    pass


# ─── classmethod / staticmethod ──────────────────────────────────────────────

class Factory:
    count = 0

    def __init__(self, value):
        self.value = value

    @classmethod
    def create(cls, value):
        return cls(value)

    @staticmethod
    def double(n):
        return n * 2


# ─── Same-named method on two unrelated classes (collision regression) ──────

class Cat:
    def speak(self):
        return "meow"


class Dog:
    def speak(self):
        return "woof"


# ─── Required constructor arg, no default ────────────────────────────────────

class Account:
    def __init__(self, owner):
        self.owner = owner

    def describe(self):
        return f"Account of {self.owner}"


# ─── Nested class ─────────────────────────────────────────────────────────────

class Outer:
    class Inner:
        def greet(self):
            return "hello from inner"


# ─── Same-scope and cross-module instance tracking ───────────────────────────

def use_derived(value):
    d = Derived(value)
    return d.derived_method()


def use_diamond(value):
    d = Diamond(value)
    return d.base_method()


def use_cross_module(radius):
    c = Circle(radius)
    return c.area()


def call_both_animals():
    cat = Cat()
    dog = Dog()
    return cat.speak() + dog.speak()
