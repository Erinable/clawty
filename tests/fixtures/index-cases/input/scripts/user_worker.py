def sync_user_profile(user_id):
    return f"sync:{user_id}"


class UserSyncWorker:
    def run(self, user_id):
        return sync_user_profile(user_id)
