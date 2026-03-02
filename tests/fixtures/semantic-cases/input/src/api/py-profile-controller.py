from src.services.py_profile_service import update_py_profile


def handle_py_profile_update(user_id, patch):
    return update_py_profile(user_id, patch)
